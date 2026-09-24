import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunLog, StepLog } from "../scenario/types";
import { PasskeyPanel } from "./PasskeyPanel";
import {
  C,
  chain,
  explorerAddr,
  isLocal,
  explorerTx,
  liveGateCheck,
  fetchLiveReport,
  loadRecordedRun,
  probeLive,
  readLive,
  runLiveStep,
  short,
  usd,
  type LiveState,
} from "./chain";

type Role = "owner" | "agent" | "verifier";

/** demo/public/runs/mcp-latest.json, written by `npm run demo-run -w mcp-server`. */
interface McpStep {
  id: string;
  title: string;
  tool: string;
  args: { scope?: string; amount?: string; relyingParty?: string; forceSubmit?: boolean; disclose?: string[] };
  result?: { tools?: string[]; availableClaims?: { disclosable: boolean }[]; authorized?: boolean; reason?: string; executed?: boolean; stoppedBy?: string; txHash?: string };
  error?: string;
}
interface McpRun {
  startedAt: string;
  steps: McpStep[];
}

/** The storyline, in order. `live` is the demo-API step that performs it. */
const PLAN: { live: string; ids: string[]; role: StepLog["role"]; title: string }[] = [
  { live: "issue", ids: ["sign", "anchor"], role: "owner", title: "Owner signs the mandate and anchors it on Monad" },
  { live: "swap-ok", ids: ["swap-ok"], role: "agent", title: "Agent swaps 80 apUSD — within its limit" },
  { live: "swap-over", ids: ["swap-over"], role: "agent", title: "Agent tries 150 apUSD — over its per-transaction limit" },
  { live: "swap-injected", ids: ["swap-injected"], role: "agent", title: "Prompt-injected agent routes funds through a look-alike DEX" },
  { live: "pay-unverified", ids: ["pay-unverified"], role: "agent", title: "Agent pays a merchant that only serves vLEI-verified owners" },
  { live: "vlei", ids: ["vlei"], role: "vlei", title: "vLEI verifier records: the owner is a verified legal entity" },
  { live: "pay-verified", ids: ["pay-verified"], role: "agent", title: "Same payment, owner now verified" },
  { live: "revoke", ids: ["revoke"], role: "owner", title: "Owner revokes the mandate" },
  { live: "swap-after-revoke", ids: ["swap-after-revoke"], role: "agent", title: "Agent swaps 10 apUSD after revocation" },
];

const REASON: Record<string, string> = {
  ExceedsPerTxLimit: "Over limit",
  ExceedsDailyLimit: "Over daily limit",
  PayeeNotAllowed: "Payee not allowed",
  OwnerNotVleiVerified: "Owner not verified",
  Revoked: "Mandate revoked",
  Expired: "Expired",
  Superseded: "Superseded",
  WrongAgent: "Wrong agent",
  BadDisclosure: "Forged claim",
  ScopeNotGranted: "Scope not granted",
  AssetNotGranted: "Asset not granted",
  NotInCredential: "Not in mandate",
};

const NAMES: Record<string, string> = {
  [C.passportDex.toLowerCase()]: "PassportDex",
  [C.passportMerchant.toLowerCase()]: "PassportMerchant",
  [C.lookalikeDex.toLowerCase()]: "Look-alike DEX",
};

function Stamp({ step, big, thud }: { step: StepLog; big?: boolean; thud?: boolean }) {
  const r = `${((step.txHash?.charCodeAt(6) ?? 7) % 9) - 6}deg`;
  const cls = `stamp ${big ? "big" : ""} ${thud ? "thud" : ""}`;
  if (step.outcome === "offchain")
    return <span className={`${cls} sign`} style={{ ["--r" as string]: r }}>Signed<small>off-chain · EIP-712</small></span>;
  if (step.outcome === "rejected")
    return (
      <span className={`${cls} deny`} style={{ ["--r" as string]: r }}>
        Denied<small>{REASON[step.reason ?? ""] ?? step.reason ?? "reverted"}</small>
      </span>
    );
  const agent = step.role === "agent";
  return (
    <span className={cls} style={{ ["--r" as string]: r }}>
      {agent ? "Granted" : "Recorded"}
      <small>{agent ? "PassportGate" : isLocal ? "on-chain" : "on Monad"}</small>
    </span>
  );
}

function mrz(run: RunLog) {
  const pad = (s: string, n: number) => (s + "<".repeat(n)).slice(0, n);
  const l1 = pad("P<MON<AGENT<PASSPORT<<EXAMPLE<TREASURY<AGENT", 44);
  const l2 = pad(`${run.agentId.padStart(9, "0")}<${run.credentialId.slice(2, 22).toUpperCase()}<${chain.id}<ERC8004`, 44);
  return `${l1}\n${l2}`;
}

function describeClaim(name: string, display: string) {
  const [kind, arg] = [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)];
  switch (kind) {
    case "scope":
      return { k: "Scope", v: <code>{display}</code> };
    case "maxPerTx":
      return { k: "Per-transaction limit", v: <>{usd(display)} apUSD</> };
    case "dailyLimit":
      return { k: "Daily limit", v: <>{usd(display)} apUSD</> };
    case "payee":
      return { k: "Allowed counterparty", v: <>{NAMES[arg] ?? short(arg)} <code>{short(arg)}</code></> };
    case "text":
      return { k: { purpose: "Purpose", ownerName: "Legal entity", mandateRef: "Mandate reference" }[arg] ?? arg, v: display };
    default:
      return { k: name, v: display };
  }
}

export default function App() {
  const [run, setRun] = useState<RunLog>();
  const [live, setLive] = useState(false);
  const [liveState, setLiveState] = useState<LiveState>();
  const [role, setRole] = useState<Role>("verifier");
  const [shown, setShown] = useState<number>(Infinity); // replay cursor
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [liveSteps, setLiveSteps] = useState<StepLog[]>([]);
  const [lastLive, setLastLive] = useState<string>();
  const [bench, setBench] = useState<{ succeeded: number; blocksSpanned: number; allReceiptsMs: number }>();
  const [mcp, setMcp] = useState<McpRun>();

  useEffect(() => {
    loadRecordedRun().then(setRun);
    // The benchmark and the MCP session were recorded on Monad testnet; a local chain shows neither.
    if (!isLocal) {
      fetch(`${import.meta.env.BASE_URL}runs/bench-latest.json`).then((r) => (r.ok ? r.json() : undefined)).then(setBench, () => {});
      fetch(`${import.meta.env.BASE_URL}runs/mcp-latest.json`).then((r) => (r.ok ? r.json() : undefined)).then(setMcp, () => {});
    }
    probeLive().then(async (ok) => {
      setLive(ok);
      if (!ok) return;
      // In live mode, show the mandate the demo API is currently using.
      const { report } = await fetchLiveReport();
      if (report) setRun({ ...report, steps: [] });
    });
  }, []);

  const refresh = useCallback(() => {
    if (run) readLive(run).then(setLiveState).catch(() => {});
  }, [run]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const steps = live ? liveSteps : run?.steps ?? [];

  const replay = () => {
    setShown(0);
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= PLAN.length) clearInterval(t);
    }, 1100);
  };

  const doLive = async (step: string) => {
    setBusy(step);
    setError(undefined);
    try {
      if (step === "issue") setLiveSteps([]);
      const r = await runLiveStep(step);
      if (r.error) throw new Error(r.error);
      if (r.report) setRun(r.report);
      setLiveSteps((prev) => [...(step === "issue" ? [] : prev), ...r.steps.filter((s) => !["register", "bind-wallet", "registration-file", "faucet", "approve"].includes(s.id))]);
      setLastLive(r.steps.at(-1)?.id);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!run) return <div className="shell"><p className="eyebrow">Loading the passport…</p></div>;

  const txCount = run.setup.length + run.steps.filter((s) => s.txHash).length;
  const status = liveState?.status ?? "…";
  const verified = liveState?.ownerAssurance === "VLEI_VERIFIED";

  return (
    <div className="shell">
      <header className="mast">
        <div>
          <div className="eyebrow">Monad Metropolis · Track 04 · Trust / Identity & AI Infrastructure</div>
          <h1 className="title">
            Agent <em>Passport</em>
          </h1>
          <p className="lede">
            Before an AI agent moves money, any protocol can check — in one call on Monad — <b>that its owner signed a mandate for it</b>,{" "}
            <b>what that mandate allows</b>, and <b>whether it still holds</b>. The counterparty sees only what it needs.
          </p>
        </div>
        <div className="mast-meta">
          <span className={`chip ${live ? "live" : ""}`}>
            <span className="dot" />
            {live ? (isLocal ? "Live · local chain (anvil)" : "Live · sending to Monad testnet") : "Recorded run · Monad testnet"}
          </span>
          <a className="chip" href={explorerAddr(C.passportGate)} target="_blank" rel="noreferrer">
            PassportGate {short(C.passportGate)}
          </a>
          <span className="eyebrow">chain {chain.id} · block {liveState?.block.toString() ?? "…"}</span>
        </div>
      </header>

      <section className="metrics" aria-label={isLocal ? "Measured on the local chain" : "Measured on Monad testnet"}>
        <div className="metric"><div className="v">{run.metrics.medianLatencyMs}<small>ms</small></div><div className="k">median submit → receipt</div></div>
        <div className="metric"><div className="v">{run.verifierView.disclosed.length}<small>/ {run.verifierView.disclosed.length + run.verifierView.hiddenClaimCount} claims</small></div><div className="k">disclosed to the DEX, each Merkle-proven</div></div>
        {bench ? (
          <div className="metric"><div className="v">{bench.succeeded}<small>actions · {bench.blocksSpanned} block</small></div><div className="k">sent back to back, each fully verified · {bench.allReceiptsMs} ms</div></div>
        ) : (
          <div className="metric"><div className="v">{txCount}<small>txs</small></div><div className="k">real transactions in this run</div></div>
        )}
        <div className="metric"><div className="v">{steps.filter((s) => s.outcome === "rejected").length}<small>/ {steps.filter((s) => s.role === "agent").length}</small></div><div className="k">agent actions denied on-chain</div></div>
      </section>

      <div className="grid">
        <aside className="passport" aria-label="Agent passport">
          <div className="guilloche" />
          <div className="pp-head">
            <h2>Agent Passport</h2>
            <span>ERC-8004 · MONAD</span>
          </div>
          <div className="pp-body">
            <div className="portrait" aria-hidden>
              <svg viewBox="0 0 56 56" fill="none" stroke="#14213D" strokeWidth="1.4">
                <rect x="10" y="14" width="36" height="28" rx="6" />
                <circle cx="22" cy="28" r="3" /><circle cx="34" cy="28" r="3" />
                <path d="M28 6v8M24 48h8M6 26h4M46 26h4" />
              </svg>
            </div>
            <div className="fields">
              <div className="field"><div className="k">Agent</div><div className="v big">Example Treasury Agent</div></div>
              <div className="field"><div className="k">ERC-8004 agent id</div><div className="v">#{run.agentId} · <a href={explorerAddr(C.identityRegistry)} target="_blank" rel="noreferrer">registry {short(C.identityRegistry)}</a></div></div>
              <div className="field"><div className="k">Agent key</div><div className="v"><a href={explorerAddr(run.agentWallet)} target="_blank" rel="noreferrer">{short(run.agentWallet, 8)}</a></div></div>
            </div>
          </div>
          <div className="pp-rows">
            <div className="pp-row">
              <div className="field"><div className="k">Holder (owner)</div><div className="v">{short(run.owner, 8)}</div></div>
              <span className={`seal ${verified ? "ok" : "gold"}`}>{verified ? "✓ vLEI verified" : "vLEI not verified"}</span>
            </div>
            <div className="pp-row">
              <div className="field"><div className="k">Mandate (credential)</div><div className="v">{short(run.credentialId, 10)}</div></div>
              <span className={`seal ${status === "Active" ? "ok" : "no"}`}>{status}</span>
            </div>
            <div className="pp-row">
              <div className="field"><div className="k">Agent wallet balance</div><div className="v">{liveState ? usd(liveState.agentUsd) : "…"} apUSD</div></div>
              <div className="field" style={{ textAlign: "right" }}><div className="k">Owner treasury</div><div className="v">{liveState ? usd(liveState.ownerUsd) : "…"} apUSD</div></div>
            </div>
            <div className="note">The agent never holds tokens: PassportGate pulls each authorized amount from the owner.</div>
          </div>
          <div className="mrz" aria-label="machine readable zone">{mrz(run)}</div>
        </aside>

        <main>
          <nav className="tabs" role="tablist">
            {(
              [
                ["owner", "Owner", "the institution"],
                ["agent", "Agent", "the AI"],
                ["verifier", "Verifier", "the DEX"],
              ] as const
            ).map(([id, label, hint]) => (
              <button key={id} className="tab" role="tab" aria-selected={role === id} onClick={() => setRole(id)}>
                <b>{label}</b> {hint}
              </button>
            ))}
          </nav>

          {role === "owner" && (
            <section className="panel" key="owner">
              <h3>The mandate</h3>
              <p className="sub">
                Signed once by the owner (EIP-712). Each line is a salted commitment under one Merkle root; only the root and the
                credential hash go on-chain. A verified role holder of a legal entity (GLEIF vLEI) can stand behind it.
              </p>
              <table className="mandate">
                <tbody>
                  {run.ownerClaims.map((c) => {
                    const d = describeClaim(c.name, c.display);
                    const toDex = run.verifierView.disclosed.some((x) => x.name === c.name);
                    return (
                      <tr key={c.name}>
                        <td>{d.k}</td>
                        <td className="val">{d.v}</td>
                        <td style={{ textAlign: "right" }}>
                          {toDex ? <span className="tag pub">shown to DEX</span> : c.name.startsWith("text:") ? <span className="tag priv">never leaves agent</span> : <span className="tag priv">not shown to DEX</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {live && (
                <div className="actions">
                  <button className="btn" disabled={!!busy} onClick={() => doLive("issue")}>{busy === "issue" ? "Signing…" : "Sign & anchor new mandate"}</button>
                  <button className="btn warn" disabled={!!busy} onClick={() => doLive("revoke")}>{busy === "revoke" ? "Revoking…" : "Revoke mandate"}</button>
                  <button className="btn ghost" disabled={!!busy} onClick={() => doLive("vlei")}>{busy === "vlei" ? "Recording…" : "vLEI verifier: record result"}</button>
                </div>
              )}
              {live && <PasskeyPanel />}
            </section>
          )}

          {role === "agent" && (
            <section className="panel" key="agent">
              <h3>The agent presents, then acts</h3>
              <p className="sub">
                Any MCP-capable agent can call the Agent Passport tools. It reveals four claims to the DEX and signs each action; the
                gate checks the claims against the anchored root, the signature against the agent's ERC-8004 key, and the limits.
              </p>
              {mcp ? (
                <McpSession run={mcp} />
              ) : (
                <pre className="mcp">
                  <span className="c">{"// MCP tool call"}</span>{"\n"}
                  present_passport({"{"} agentId: <span className="s">"{run.agentId}"</span>, disclose: [{run.verifierView.disclosed.map((d, i) => (
                    <span key={d.name}>{i ? ", " : ""}<span className="s">"{d.name.split(":")[0]}"</span></span>
                  ))}] {"}"}){"\n"}
                  <span className="c">{"// →"}</span> <span className="ok">{run.verifierView.disclosed.length} claims disclosed</span>, {run.verifierView.hiddenClaimCount} stay hidden (salted){"\n"}
                  check_authorization({"{"} scope: <span className="s">"dex.swap"</span>, amount: <span className="s">"80000000"</span> {"}"}) <span className="c">{"// → PassportGate.check on Monad"}</span>
                </pre>
              )}
              {live && (
                <div className="actions">
                  {PLAN.filter((p) => p.role === "agent").map((p) => (
                    <button key={p.live} className={`btn ${p.live === "swap-ok" || p.live === "pay-verified" ? "" : "ghost"}`} disabled={!!busy} onClick={() => doLive(p.live)}>
                      {busy === p.live ? "Sending…" : p.title.replace(/^Agent /, "").replace(/ —.*$/, "")}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {role === "verifier" && <VerifierPanel run={run} verified={verified} status={status} />}

          <div className="ledger-head">
            <h3>Entries &amp; refusals</h3>
            {!live && <button className="btn ghost" onClick={replay}>Replay run</button>}
            {live && error && <span className="note" style={{ color: "var(--deny)" }}>{error}</span>}
          </div>
          <Ledger steps={steps} shown={live ? Infinity : shown} run={run} lastLive={lastLive} />
          <p className="note">
            Rejected actions are real transactions too: the gate reverts them on-chain with its reason. Recorded {new Date(run.finishedAt).toLocaleString()}.
          </p>
        </main>
      </div>

      <footer className="foot">
        <span>Agent Passport · MIT · <a href="https://github.com/zuemen/agent-passport" target="_blank" rel="noreferrer">github.com/zuemen/agent-passport</a></span>
        <span>Test data only — fictional entity, no real LEI · Monad testnet</span>
      </footer>
    </div>
  );
}

function Ledger({ steps, shown, run, lastLive }: { steps: StepLog[]; shown: number; run: RunLog; lastLive?: string }) {
  let n = 0;
  return (
    <div className="ledger">
      {PLAN.map((p, i) => {
        const found = steps.filter((s) => p.ids.includes(s.id));
        const main = found.find((s) => s.txHash) ?? found[0];
        const visible = i < shown && !!main;
        n += 1;
        return (
          <div key={p.live} className={`entry ${visible ? "" : "pending"}`}>
            <div className="n">{String(n).padStart(2, "0")}</div>
            <div className={`who ${p.role}`}>{p.role === "vlei" ? "vLEI verifier" : p.role}</div>
            <div>
              <div className="what">{p.title}</div>
              {visible && main && (
                <div className="meta">
                  {main.reason && <span>reason <b>{main.reason}</b></span>}
                  {main.block && <span>block {main.block}</span>}
                  {main.latencyMs && <span>{main.latencyMs} ms</span>}
                  {main.detail?.relyingParty && <span>via {NAMES[main.detail.relyingParty.toLowerCase()] ?? short(main.detail.relyingParty)}</span>}
                  {main.txHash && <a href={explorerTx(main.txHash)} target="_blank" rel="noreferrer">tx {short(main.txHash)} ↗</a>}
                </div>
              )}
            </div>
            <div className="st">{main && <Stamp step={main} thud={visible && (shown !== Infinity || lastLive === main.id)} />}</div>
          </div>
        );
      })}
      <div style={{ display: "none" }}>{run.credentialId}</div>
    </div>
  );
}

const PARTY: Record<string, string> = {
  [C.passportDex.toLowerCase()]: "PassportDex",
  [C.lookalikeDex.toLowerCase()]: "Look-alike DEX",
  [C.passportMerchant.toLowerCase()]: "PassportMerchant",
};

/** The recorded MCP session: every tool call the agent made and what came back, with its transactions. */
function McpSession({ run }: { run: McpRun }) {
  const args = (a: McpStep["args"]) =>
    [
      a.scope && `"${a.scope}"`,
      a.amount && `${usd(BigInt(a.amount))} apUSD`,
      a.relyingParty && `→ ${PARTY[a.relyingParty.toLowerCase()] ?? short(a.relyingParty)}`,
      a.forceSubmit && "forceSubmit",
      a.disclose && `disclose [${a.disclose.join(", ")}]`,
    ]
      .filter(Boolean)
      .join(", ");
  const result = (s: McpStep) => {
    const r = s.result;
    if (s.error) return <span className="no">✗ {s.error}</span>;
    if (!r) return null;
    if (r.tools) return <span className="ok">✓ {r.tools.join(" · ")}</span>;
    if (r.availableClaims) {
      const open = r.availableClaims.filter((c) => c.disclosable).length;
      return <span className="ok">✓ {r.availableClaims.length} claims, {r.availableClaims.length - open} private by policy</span>;
    }
    if (s.tool === "check_authorization") return <span className={r.authorized ? "ok" : "no"}>{r.authorized ? "✓ authorized" : `✗ ${r.reason}`} (eth_call)</span>;
    const tx = r.txHash && <> · <a href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">tx {short(r.txHash)} ↗</a></>;
    if (r.executed) return <span className="ok">✓ settled on Monad{tx}</span>;
    if (r.stoppedBy === "on-chain") return <span className="no">✗ reverted on Monad: {r.reason}{tx}</span>;
    return <span className="warn">■ stopped before sending: {r.reason}</span>;
  };
  return (
    <pre className="mcp">
      <span className="c">{`// recorded MCP session, ${run.startedAt.slice(0, 10)} — scripted client (npm run demo-run -w mcp-server)`}</span>
      {run.steps.map((s) => (
        <span key={s.id}>
          {"\n"}
          {s.tool}({args(s.args)}){"\n"}
          {"  "}
          {result(s)}
        </span>
      ))}
    </pre>
  );
}

function VerifierPanel({ run, verified, status }: { run: RunLog; verified: boolean; status: string }) {
  const [which, setWhich] = useState<"dex" | "merchant">("dex");
  const [amount, setAmount] = useState(80);
  const [verdict, setVerdict] = useState<{ authorized: boolean; reason: string; at: number }>();
  const [asking, setAsking] = useState(false);
  const seq = useRef(0);

  const ask = async () => {
    setAsking(true);
    const id = ++seq.current;
    try {
      const v = await liveGateCheck(run, which, amount);
      if (id === seq.current) setVerdict({ ...v, at: Date.now() });
    } finally {
      setAsking(false);
    }
  };

  const hidden = useMemo(() => Array.from({ length: run.verifierView.hiddenClaimCount }), [run]);
  const disclosed = run.verifierView.disclosed.map((d) => describeClaim(d.name, d.value));

  return (
    <section className="panel" key="verifier">
      <h3>What the DEX sees</h3>
      <p className="sub">
        Four claims, each proven against the root the owner anchored — and nothing else. Not the owner's name, not the
        purpose, not the other counterparties. Only whether a verified legal entity stands behind the agent.
      </p>
      <div className="doc">
        <div className="doc-line"><span className="k">Agent</span><span>ERC-8004 #{run.agentId} · key {short(run.agentWallet)}</span></div>
        {disclosed.map((d, i) => (
          <div className="doc-line" key={i}><span className="k">{d.k}</span><span>{d.v}</span></div>
        ))}
        <div className="doc-line"><span className="k">Owner</span><span className={`seal ${verified ? "ok" : "gold"}`}>{verified ? "✓ vLEI verification on record" : "no vLEI verification on record"}</span></div>
        <div className="doc-line"><span className="k">Mandate status</span><span className={`seal ${status === "Active" ? "ok" : "no"}`}>{status} · read live from Monad</span></div>
        {hidden.map((_, i) => (
          <div className="doc-line" key={`h${i}`}><span className="k">undisclosed</span><span className="redact" style={{ width: `${40 + ((i * 37) % 50)}%` }} /></div>
        ))}
      </div>

      <div className="check">
        <div>
          <div className="seg" role="group" aria-label="relying party">
            <button aria-pressed={which === "dex"} onClick={() => setWhich("dex")}>PassportDex · dex.swap</button>
            <button aria-pressed={which === "merchant"} onClick={() => setWhich("merchant")}>Merchant · requires vLEI</button>
          </div>
          <label htmlFor="amt">Ask PassportGate, right now, on Monad</label>
          <div className="amt">{amount}<small>apUSD</small></div>
          <input id="amt" type="range" min={1} max={300} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          <div className="actions"><button className="btn" onClick={ask} disabled={asking}>{asking ? "Asking…" : "Check authorization"}</button></div>
        </div>
        <div className="verdict">
          {verdict ? (
            <Stamp
              key={verdict.at}
              big
              thud
              step={{ id: "check", role: "agent", title: "", expect: "success", outcome: verdict.authorized ? "success" : "rejected", reason: verdict.reason, txHash: String(verdict.at) }}
            />
          ) : (
            <span className="note">eth_call · no transaction</span>
          )}
        </div>
      </div>
    </section>
  );
}
