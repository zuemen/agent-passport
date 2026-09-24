/**
 * Pre-recording check (npm run preflight -w demo). Read-only: it never signs or sends anything.
 * Keys from .env are only turned into addresses, to confirm the live demo uses the recorded wallets.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatEther, http, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { MONAD_TESTNET, credentialStatus, monadTestnet } from "@agent-passport/sdk";
import { env, mcpCredentialFile, repoRoot } from "./env.js";

const API = "http://127.0.0.1:18790";
const APP = "http://localhost:15173";
/** One full live run costs the agent ≈0.25 MON (Monad charges the gas limit, rejected actions included). */
const MIN_BALANCE = { agent: 0.3, owner: 0.1, deployer: 0.1 } as const;

type Level = "ok" | "fail" | "warn";
const results: { level: Level; what: string; detail: string }[] = [];
const report = (level: Level, what: string, detail: string) => results.push({ level, what, detail });

const client = createPublicClient({ chain: monadTestnet, transport: http(env.MONAD_TESTNET_RPC_URL || undefined) });
const readJson = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const recorded = readJson("demo/public/runs/latest.json") as { owner: Address; agentWallet: Address };
const deployer = (readJson("contracts/deployments/10143.json") as { deployer: Address }).deployer;

async function reachable(url: string): Promise<Response | undefined> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(1500) });
  } catch {
    return undefined;
  }
}

async function checkChain() {
  const t0 = Date.now();
  try {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== 10143) return report("fail", "Monad testnet RPC", `chain id ${chainId}, expected 10143`);
    report("ok", "Monad testnet RPC", `block ${block.number}, ${Date.now() - t0} ms`);
    // Intents take their deadline from the chain, but a skewed PC clock still confuses logs and explorers.
    const skew = Number(block.timestamp) - Math.floor(Date.now() / 1000);
    report(
      Math.abs(skew) <= 60 ? "ok" : "warn",
      "Local clock",
      Math.abs(skew) <= 60 ? `within ${Math.abs(skew)} s of the chain` : `${skew > 0 ? "behind" : "ahead of"} the chain by ${Math.abs(skew)} s — sync Windows time (Settings → Time & language → Sync now)`,
    );
  } catch (e) {
    report("fail", "Monad testnet RPC", `unreachable (${(e as Error).message.split("\n")[0]}); set MONAD_TESTNET_RPC_URL`);
  }
}

async function checkContracts() {
  const entries = Object.entries(MONAD_TESTNET).filter(([name]) => name !== "vleiVerifier");
  const codes = await Promise.all(entries.map(([, address]) => client.getCode({ address })));
  const missing = entries.filter((_, i) => !codes[i] || codes[i] === "0x").map(([name]) => name);
  if (missing.length) report("fail", "Contracts", `no code at: ${missing.join(", ")}`);
  else report("ok", "Contracts", `${entries.length} deployed contracts have code`);
}

async function checkWallets() {
  const wallets: { role: keyof typeof MIN_BALANCE; envKey: string; expected: Address }[] = [
    { role: "agent", envKey: "DEMO_AGENT_KEY", expected: recorded.agentWallet },
    { role: "owner", envKey: "DEMO_OWNER_KEY", expected: recorded.owner },
    { role: "deployer", envKey: "DEPLOYER_PRIVATE_KEY", expected: deployer },
  ];
  for (const w of wallets) {
    const key = env[w.envKey] as Hex | undefined;
    if (!key) {
      report("fail", `${w.role} key`, `${w.envKey} is not set in .env (live mode needs it)`);
      continue;
    }
    const address = privateKeyToAddress(key);
    if (address.toLowerCase() !== w.expected.toLowerCase())
      report("warn", `${w.role} key`, `${w.envKey} is ${address}, the recorded run used ${w.expected}`);
    const balance = Number(formatEther(await client.getBalance({ address })));
    const min = MIN_BALANCE[w.role];
    report(
      balance >= min ? "ok" : "fail",
      `${w.role} balance`,
      `${balance.toFixed(4)} MON (need ≥ ${min})${balance >= min ? "" : " — top up at https://faucet.monad.xyz"}`,
    );
  }
}

async function checkMandate(label: string, credentialId: Hex | undefined, fix: string) {
  if (!credentialId) return report("fail", label, `no credential yet — ${fix}`);
  const s = await credentialStatus(client, MONAD_TESTNET.credentialStatusRegistry, credentialId);
  report(
    s.status === "Active" ? "ok" : "fail",
    label,
    `${credentialId.slice(0, 10)}… is ${s.status}, owner ${s.ownerAssurance}${s.status === "Active" ? "" : ` — ${fix}`}`,
  );
}

async function checkDemo() {
  const api = await reachable(`${API}/api/state`);
  if (!api?.ok) report("fail", "Demo API (live mode)", `not running on ${API} — npm run api -w demo`);
  else {
    const state = (await api.json()) as { credentialId?: Hex };
    report("ok", "Demo API (live mode)", `running on ${API}`);
    const current = state.credentialId
      ? `current ${state.credentialId.slice(0, 10)}… is ${(await credentialStatus(client, MONAD_TESTNET.credentialStatusRegistry, state.credentialId)).status}`
      : "none yet";
    report("ok", "Live-mode mandate", `${current}; the video's first step issues a fresh one`);
  }
  const app = await reachable(APP);
  report(app?.ok ? "ok" : "fail", "Demo app", app?.ok ? `running on ${APP}` : `not running — npm run dev -w demo`);
}

async function checkMcp() {
  if (!existsSync(join(repoRoot, "mcp-server", "dist", "index.js")))
    report("fail", "MCP server build", "missing mcp-server/dist — npm run build -w mcp-server");
  else report("ok", "MCP server build", "mcp-server/dist/index.js present");
  const file = mcpCredentialFile();
  const credentialId = file ? (JSON.parse(readFileSync(file, "utf8")).credentialId as Hex) : undefined;
  await checkMandate("MCP mandate", credentialId, `issue a fresh one: curl -X POST ${API}/api/step/issue (docs/AGENT_DEMO.md)`);
  if (!process.env.DEMO_AGENT_KEY)
    report("warn", "MCP agent key", "DEMO_AGENT_KEY is not exported in this shell; .mcp.json reads it from the environment");
}

function checkVlei(): Promise<void> {
  return new Promise((resolve) =>
    execFile("docker", ["ps", "--filter", "name=agentpassport-vlei", "--format", "{{.Names}}"], (err, stdout) => {
      const names = stdout?.trim().split(/\r?\n/).filter(Boolean) ?? [];
      if (err || !names.length)
        report("warn", "vLEI stack (optional)", "not running; the video can show the recorded vLEI step (block 65050571)");
      else report("ok", "vLEI stack (optional)", `${names.length} containers up`);
      resolve();
    }),
  );
}

for (const check of [checkChain, checkContracts, checkWallets, checkDemo, checkMcp, checkVlei]) await check();

const icon: Record<Level, string> = { ok: "✅", fail: "❌", warn: "⚠️ " };
for (const r of results) console.log(`${icon[r.level]} ${r.what.padEnd(24)} ${r.detail}`);
const failed = results.filter((r) => r.level === "fail").length;
console.log(failed ? `\n${failed} check(s) must be fixed before recording.` : "\nReady to record.");
process.exitCode = failed ? 1 : 0;
