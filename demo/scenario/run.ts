import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLORER, deployment, runsDir } from "./env.js";
import { Scenario } from "./scenario.js";

/**
 * npm run scenario  — runs the full storyline on Monad testnet and writes
 * demo/public/runs/latest.json (+ a timestamped copy) for the demo app and the README.
 * With DEMO_NETWORK=local (npm run scenario:local) it runs on a local anvil chain and writes to demo/.state-local/runs.
 */
const started = new Date();
const icon = { success: "✅", rejected: "❌", offchain: "✍️ " } as const;
const s = new Scenario((step) => {
  const tag = step.reason ? ` — ${step.reason}` : "";
  const ms = step.latencyMs ? ` (${step.latencyMs} ms, block ${step.block})` : "";
  console.log(`${icon[step.outcome]} [${step.role}] ${step.title}${tag}${ms}`);
  if (step.txHash) console.log(`   ${EXPLORER ? `${EXPLORER}/tx/` : "tx "}${step.txHash}`);
});

await s.ensureAgent();
await s.issue();
await s.swap("swap-ok", "Agent swaps 80 apUSD within its limit", 80);
await s.swap("swap-over", "Agent tries 150 apUSD — over its per-transaction limit", 150, { expect: "rejected" });
await s.swap("swap-injected", "Prompt-injected agent routes 50 apUSD through a look-alike DEX", 50, {
  dex: deployment.lookalikeDex,
  expect: "rejected",
});
await s.pay("pay-unverified", "Agent pays a merchant that requires a vLEI-verified owner", 5, "rejected");
await s.recordVlei();
await s.pay("pay-verified", "Same payment after the owner's vLEI is verified", 5, "success");
await s.revoke();
await s.swap("swap-after-revoke", "Agent swaps 10 apUSD after revocation", 10, { expect: "rejected" });

const log = s.report(started);
const dir = runsDir;
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "latest.json"), JSON.stringify(log, null, 2));
writeFileSync(join(dir, `${started.toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(log, null, 2));

const bad = log.steps.filter((x) => x.expect !== "offchain" && x.expect !== x.outcome);
console.log(`\nmedian latency ${log.metrics.medianLatencyMs} ms · revoke→rejection ${log.metrics.blocksFromRevokeToRejection} block(s)`);
if (bad.length) {
  console.error(`UNEXPECTED: ${bad.map((x) => x.id).join(", ")}`);
  process.exit(1);
}
