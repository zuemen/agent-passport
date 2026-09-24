/**
 * npm run why -w demo -- <txHash> [...] — why did a transaction fail? Explorers show a reverted transaction
 * without its reason; this reads it (the transaction's call trace, else a replay at its block — read-only)
 * and decodes it with the Agent Passport ABIs, e.g. NotAuthorized(PayeeNotAllowed) from PassportGate.
 */
import { createPublicClient, http, type Hex } from "viem";
import { REASONS, monadTestnet, revertReasonOf } from "@agent-passport/sdk";
import { env } from "./env.js";

const client = createPublicClient({ chain: monadTestnet, transport: http(env.MONAD_TESTNET_RPC_URL || undefined) });

async function why(hash: Hex): Promise<string> {
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.status === "success") return `succeeded in block ${receipt.blockNumber}`;
  const reason = await revertReasonOf(client, hash);
  if (!reason) return `reverted in block ${receipt.blockNumber}; the reason could not be read`;
  return `reverted in block ${receipt.blockNumber}: ${(REASONS as readonly string[]).includes(reason) ? `NotAuthorized(${reason})` : reason}`;
}

const hashes = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{64}$/.test(a)) as Hex[];
if (!hashes.length) {
  console.error("usage: npm run why -w demo -- <txHash> [...]");
  process.exit(1);
}
for (const h of hashes) {
  try {
    console.log(`${h.slice(0, 10)}…  ${await why(h)}`);
  } catch (e) {
    console.log(`${h.slice(0, 10)}…  could not look it up: ${(e as Error).message.split("\n")[0]}`);
  }
}
