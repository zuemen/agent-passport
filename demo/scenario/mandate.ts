import { EXPLORER } from "./env.js";
import { Scenario } from "./scenario.js";

/**
 * Sign and anchor a fresh mandate for the scenario's agent, and hand it to the agent-side MCP server
 * (its credentials directory). The storyline ends with a revocation; `npm run scenario:local` runs this before
 * its MCP part. With DEMO_NETWORK=local it acts on the local chain; otherwise it sends Monad testnet transactions.
 */
const icon = { success: "✅", rejected: "❌", offchain: "✍️ " } as const;
const s = new Scenario((step) => {
  console.log(`${icon[step.outcome]} [${step.role}] ${step.title}`);
  if (step.txHash) console.log(`   ${EXPLORER ? `${EXPLORER}/tx/` : "tx "}${step.txHash}`);
});
await s.ensureAgent();
await s.issue();
console.log(`mandate ${s.held!.credentialId} for agent #${s.agentId}`);
