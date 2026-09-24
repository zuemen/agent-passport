import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SoftPasskey } from "../../sdk/test/softPasskey.js";
import { EXPLORER, runsDir, stateDir } from "./env.js";
import { PasskeyOwnerFlow } from "./passkeyOwner.js";

/**
 * npm run passkey -w demo — the owner is a passkey-controlled smart account (P-256, verified on-chain
 * via Monad's 0x0100 precompile). A relayer pays gas; the owner never holds MON or a seed phrase.
 * Uses a software passkey; the demo app does the same with the user's real passkey (Windows Hello,
 * Touch ID, Face ID).
 */
mkdirSync(stateDir, { recursive: true });
const keyFile = join(stateDir, "passkey.pem");
const passkey = existsSync(keyFile) ? SoftPasskey.fromPem(readFileSync(keyFile, "utf8")) : SoftPasskey.generate();
writeFileSync(keyFile, passkey.toPem());

const flow = new PasskeyOwnerFlow(passkey.x, passkey.y, (ch) => passkey.sign(ch), (s) => {
  console.log(`${s.tx ? (s.status === "success" ? "✅" : "❌") : "✍️ "} ${s.step}${s.reason ? ` — ${s.reason}` : ""}`);
  if (s.tx) console.log(`   ${EXPLORER ? `${EXPLORER}/tx/` : "tx "}${s.tx}`);
});

const GRANTED = "Agent swaps 10 apUSD from the passkey owner's funds";
const REFUSED = "Agent swaps 10 apUSD after the passkey revocation";
console.log(`owner = PasskeyAccount ${await flow.ensureAccount()}`);
await flow.setup();
await flow.swap(GRANTED, 10_000_000n);
await flow.revoke();
await flow.swap(REFUSED, 10_000_000n);

mkdirSync(runsDir, { recursive: true });
writeFileSync(
  join(runsDir, "passkey-latest.json"),
  JSON.stringify(
    { at: new Date().toISOString(), owner: flow.account, agentId: flow.agentId!.toString(), credentialId: flow.held!.credentialId, steps: flow.steps },
    null,
    2,
  ),
);

// Exit non-zero on a surprise, so scenario:local can rely on it.
const step = (name: string) => flow.steps.find((s) => s.step === name);
if (step(GRANTED)?.status !== "success" || step(REFUSED)?.reason !== "Revoked") {
  console.error("✗ expected the first swap granted and the one after the revocation refused with Revoked");
  process.exitCode = 1;
}
