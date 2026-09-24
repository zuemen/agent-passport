/**
 * npm run why -w demo -- <txHash> [...] — why did a transaction fail? Explorers show a reverted transaction
 * without its reason; this replays it (eth_call at its block, read-only) and decodes the error with the
 * Agent Passport ABIs, e.g. NotAuthorized(PayeeNotAllowed) from PassportGate.
 */
import { BaseError, createPublicClient, decodeErrorResult, http, type Abi, type Hex } from "viem";
import { REASONS, monadTestnet, passportDexAbi, passportGateAbi, passportMerchantAbi } from "@agent-passport/sdk";
import { env } from "./env.js";

const client = createPublicClient({ chain: monadTestnet, transport: http(env.MONAD_TESTNET_RPC_URL || undefined) });
const errorsAbi = [...passportGateAbi, ...passportDexAbi, ...passportMerchantAbi].filter((x) => x.type === "error") as Abi;

async function why(hash: Hex): Promise<string> {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  if (receipt.status === "success") return `succeeded in block ${receipt.blockNumber}`;
  try {
    await client.call({ account: tx.from, to: tx.to!, data: tx.input, value: tx.value, blockNumber: receipt.blockNumber });
    return `reverted in block ${receipt.blockNumber}, but the replay succeeds (state changed within the block)`;
  } catch (e) {
    const data = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data : undefined;
    if (!data) return `reverted in block ${receipt.blockNumber}; no revert data (${(e as Error).message.split("\n")[0]})`;
    try {
      const { errorName, args } = decodeErrorResult({ abi: errorsAbi, data });
      const detail = errorName === "NotAuthorized" ? `NotAuthorized(${REASONS[Number(args?.[0])]})` : `${errorName}(${(args ?? []).join(", ")})`;
      return `reverted in block ${receipt.blockNumber}: ${detail}`;
    } catch {
      return `reverted in block ${receipt.blockNumber}: unknown error ${data.slice(0, 10)}`;
    }
  }
}

const hashes = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{64}$/.test(a)) as Hex[];
if (!hashes.length) {
  console.error("usage: npm run why -w demo -- <txHash> [...]");
  process.exit(1);
}
for (const h of hashes) console.log(`${h.slice(0, 10)}…  ${await why(h)}`);
