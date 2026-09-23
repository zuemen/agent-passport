/**
 * npm run gas -w demo — what PassportGate.check costs on Monad testnet, measured with eth_estimateGas
 * against the agent's current mandate (mcp-server/credentials/agent-1.json). Read-only: nothing is signed or sent.
 * The estimate is for a standalone call, so it includes the 21,000 base cost and the calldata.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, http } from "viem";
import {
  MONAD_TESTNET as C,
  REASONS,
  credentialStatus,
  deserializeCredential,
  monadTestnet,
  passportGateAbi,
  scopeHash,
  toGatePresentation,
} from "@agent-passport/sdk";
import { env, repoRoot } from "./env.js";

const client = createPublicClient({ chain: monadTestnet, transport: http(env.MONAD_TESTNET_RPC_URL || undefined) });
const held = deserializeCredential(readFileSync(join(repoRoot, "mcp-server", "credentials", "agent-1.json"), "utf8"));
const status = await credentialStatus(client, C.credentialStatusRegistry, held.credentialId);
console.log(`mandate ${held.credentialId.slice(0, 10)}… ${status.status}, owner ${status.ownerAssurance}, agent #${status.agentId}`);

const cases = [
  { label: "dex.swap at PassportDex", scope: "dex.swap", relyingParty: C.passportDex },
  { label: "commerce.pay at PassportMerchant (vLEI required)", scope: "commerce.pay", relyingParty: C.passportMerchant },
];
for (const c of cases) {
  const presentation = toGatePresentation(held, { scope: c.scope, asset: C.demoUsd, relyingParty: c.relyingParty });
  const args = [status.agentId, scopeHash(c.scope), C.demoUsd, 1_000_000n, c.relyingParty, presentation] as const;
  const reason = await client.readContract({ address: C.passportGate, abi: passportGateAbi, functionName: "check", args });
  const gas = await client.estimateGas({
    to: C.passportGate,
    data: encodeFunctionData({ abi: passportGateAbi, functionName: "check", args }),
  });
  console.log(`${c.label.padEnd(50)} ${REASONS[reason].padEnd(22)} ${gas} gas`);
}
