import { BaseError, decodeErrorResult, parseAbi, type Abi, type Hex, type PublicClient } from "viem";
import { passportDexAbi, passportGateAbi, passportMerchantAbi } from "./abi.js";
import { REASONS } from "./chain.js";

const ERC20_ERRORS = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);
const KNOWN_ERRORS = [...passportGateAbi, ...passportDexAbi, ...passportMerchantAbi, ...ERC20_ERRORS].filter(
  (x) => x.type === "error",
) as Abi;

/**
 * Readable reason for revert data: the gate's reason code (e.g. "PayeeNotAllowed"), another Agent Passport or
 * ERC-20 error, an Error(string) message, or the unknown selector.
 */
export function decodeRevertData(data: Hex | undefined): string {
  if (!data || data === "0x") return "reverted without data";
  try {
    const { errorName, args } = decodeErrorResult({ abi: KNOWN_ERRORS, data });
    if (errorName === "NotAuthorized") return REASONS[Number(args?.[0])] ?? `NotAuthorized(${String(args?.[0])})`;
    if (errorName === "Error") return String(args?.[0]);
    return args?.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
  } catch {
    return `unknown error ${data.slice(0, 10)}`;
  }
}

/**
 * Why a mined transaction reverted (undefined if it succeeded or no reason could be read). Uses the transaction's
 * own call trace when the node offers debug_traceTransaction, otherwise replays it at its block with its gas.
 */
export async function revertReasonOf(client: PublicClient, hash: Hex): Promise<string | undefined> {
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.status === "success") return undefined;
  try {
    const trace = (await client.request({
      method: "debug_traceTransaction",
      params: [hash, { tracer: "callTracer" }],
    } as never)) as { output?: Hex; error?: string } | null;
    if (trace?.error) return trace.output && trace.output !== "0x" ? decodeRevertData(trace.output) : trace.error;
  } catch {
    // no debug API on this node: replay instead
  }
  const tx = await client.getTransaction({ hash });
  try {
    await client.call({ account: tx.from, to: tx.to!, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber });
    return undefined; // the replay succeeds: state changed later in the block
  } catch (e) {
    const found = e instanceof BaseError ? e.walk((x) => typeof (x as { data?: unknown }).data === "string") : null;
    const data = (found as { data?: Hex } | null)?.data;
    return data === undefined ? undefined : decodeRevertData(data);
  }
}
