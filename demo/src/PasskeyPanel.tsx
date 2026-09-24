import { useEffect, useState } from "react";
import { explorerAddr, explorerTx, isLocal, short } from "./chain";
import {
  approve,
  createPasskey,
  loadPasskey,
  passkeyStatus,
  passkeySupported,
  startPasskeyAction,
  type PasskeyStatus,
  type StoredPasskey,
} from "./passkey";

const ACTIONS: { id: string; label: string; primary?: boolean }[] = [
  { id: "setup", label: "Set up agent with passkey", primary: true },
  { id: "swap", label: "Agent swaps 10 apUSD" },
  { id: "revoke", label: "Revoke with passkey" },
  { id: "swap-after-revoke", label: "Agent swaps again" },
];

/** Live mode only: the owner is the user's own passkey; every owner action is one biometric approval. */
export function PasskeyPanel() {
  const [pk, setPk] = useState<StoredPasskey | undefined>(loadPasskey);
  const [st, setSt] = useState<PasskeyStatus>();
  const [error, setError] = useState<string>();
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => passkeyStatus().then((s) => alive && setSt(s), () => {});
    tick();
    const t = setInterval(tick, 800);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const running = st?.job?.status === "running";
  const run = async (action: string) => {
    setError(undefined);
    try {
      await startPasskeyAction(action, pk!);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const doApprove = async () => {
    if (!st?.pending || !pk) return;
    setApproving(true);
    setError(undefined);
    try {
      await approve(pk, st.pending.challenge);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApproving(false);
    }
  };

  if (!passkeySupported()) return <p className="note">This browser has no WebAuthn support.</p>;

  return (
    <div className="passkey">
      <h4>Owner with a passkey — no seed phrase, no gas</h4>
      <p className="sub">
        Your device's passkey (Windows Hello, Touch ID, Face ID) controls a smart account that owns the agent. Each owner
        action is one biometric approval, verified on-chain by {isLocal ? "the P-256 precompile (Foundry 1.8+ runs the local chain under Monad's rules; older anvil falls back to verifying in Solidity)" : "Monad's P-256 precompile"}; a relayer pays the gas.
      </p>
      {!pk ? (
        <button className="btn" onClick={() => createPasskey().then(setPk, (e) => setError((e as Error).message))}>
          Create a passkey
        </button>
      ) : (
        <>
          <div className="meta-line">
            passkey {short(pk.qx, 6)}
            {st?.account && (
              <>
                {" · owner account "}
                <a href={explorerAddr(st.account)} target="_blank" rel="noreferrer">{short(st.account)}</a>
              </>
            )}
            {st?.agentId && <> · agent #{st.agentId}</>}
          </div>
          <div className="actions">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                className={`btn ${a.primary ? "" : "ghost"}`}
                disabled={running || (a.id !== "setup" && !st?.credentialId)}
                onClick={() => run(a.id)}
              >
                {running && st?.job?.action === a.id ? "Working…" : a.label}
              </button>
            ))}
          </div>
          {st?.pending && (
            <div className="approve">
              <span>Approval needed: {st.pending.purpose}</span>
              <button className="btn warn" disabled={approving} onClick={doApprove}>
                {approving ? "Waiting for passkey…" : "Approve with passkey"}
              </button>
            </div>
          )}
          <ol className="pk-steps">
            {st?.steps.map((s, i) => (
              <li key={i}>
                <span className={s.tx ? (s.status === "success" ? "ok" : "no") : "sig"}>{s.tx ? (s.status === "success" ? "✓" : "✕") : "✍"}</span>
                {s.step}
                {s.reason && <b> — {s.reason}</b>}
                {s.tx && (
                  <a href={explorerTx(s.tx)} target="_blank" rel="noreferrer"> tx {short(s.tx)} ↗</a>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {(error || st?.job?.status === "error") && <p className="note" style={{ color: "var(--deny)" }}>{error ?? st?.job?.error}</p>}
    </div>
  );
}
