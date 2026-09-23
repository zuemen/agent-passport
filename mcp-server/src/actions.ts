import {
  createWalletClient,
  http,
  isAddressEqual,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import {
  agentIdentityRegistryAbi,
  buildIntent,
  checkAuthorization,
  passportDexAbi,
  passportGateAbi,
  passportMerchantAbi,
  signIntent,
  toGatePresentation,
  type HeldCredential,
} from "@agent-passport/sdk";

/** Relying-party integrations this agent knows how to call, by scope. */
export type ActionScope = "dex.swap" | "commerce.pay";

export interface ActionContext {
  client: PublicClient;
  chain: Chain;
  rpcUrl?: string;
  gate: Address;
  identityRegistry: Address;
  agent: LocalAccount;
  explorer: string;
}

export interface ActionResult {
  executed: boolean;
  /** Where the action stopped, if it did not go through. */
  stoppedBy?: "mandate" | "pre-flight" | "on-chain";
  reason: string;
  txHash?: string;
  txUrl?: string;
  status?: "success" | "reverted";
  block?: string;
}

/**
 * Perform one action as the agent: build the intent, check it against the gate (eth_call), and only
 * then sign and submit it to the relying party. The on-chain gate is the real guard; the pre-flight
 * just avoids paying for a transaction that will revert. `forceSubmit` sends it anyway, so the
 * refusal is recorded on-chain (useful for demonstrations and audits).
 */
export async function executeAction(
  ctx: ActionContext,
  held: HeldCredential,
  a: { scope: ActionScope; asset: Address; amount: bigint; relyingParty: Address; forceSubmit?: boolean },
): Promise<ActionResult> {
  // The key this server signs with must be the agent's registered ERC-8004 wallet.
  const wallet = await ctx.client.readContract({
    address: ctx.identityRegistry,
    abi: agentIdentityRegistryAbi,
    functionName: "getAgentWallet",
    args: [held.authorization.agentId],
  });
  if (!isAddressEqual(wallet, ctx.agent.address)) {
    return { executed: false, stoppedBy: "mandate", reason: `signing key ${ctx.agent.address} is not agent #${held.authorization.agentId}'s wallet` };
  }

  let presentation;
  try {
    presentation = toGatePresentation(held, { scope: a.scope, asset: a.asset, relyingParty: a.relyingParty });
  } catch {
    // The mandate names no such scope/asset/counterparty. Nothing to present — refuse locally.
    if (!a.forceSubmit) {
      return { executed: false, stoppedBy: "mandate", reason: "NotInCredential: the mandate does not cover this scope, asset or counterparty" };
    }
    // For a forced submission, present the closest real claims; the gate will name the mismatch.
    const payee = held.claims.find((c) => c.name.startsWith("payee:"))!.name.slice("payee:".length) as Address;
    presentation = toGatePresentation(held, { scope: a.scope, asset: a.asset, relyingParty: payee });
  }

  const pre = await checkAuthorization(ctx.client, ctx.gate, {
    agentId: held.authorization.agentId,
    scope: a.scope,
    asset: a.asset,
    amount: a.amount,
    relyingParty: a.relyingParty,
    presentation,
  });
  if (!pre.authorized && !a.forceSubmit) return { executed: false, stoppedBy: "pre-flight", reason: pre.reason };

  const intent = buildIntent({ credentialId: held.credentialId, scope: a.scope, asset: a.asset, amount: a.amount, relyingParty: a.relyingParty });
  const signature = await signIntent(ctx.agent, ctx.chain.id, ctx.gate, intent);
  const wc = createWalletClient({ chain: ctx.chain, transport: http(ctx.rpcUrl), account: ctx.agent });
  const errors = passportGateAbi.filter((x) => x.type === "error");
  const gas = pre.authorized ? undefined : 400_000n; // a doomed tx cannot be estimated; cap it

  const hash: Hex =
    a.scope === "dex.swap"
      ? await wc.writeContract({
          address: a.relyingParty,
          abi: [...passportDexAbi, ...errors],
          functionName: "swap",
          args: [intent, presentation, signature, 0n],
          gas,
        })
      : await wc.writeContract({
          address: a.relyingParty,
          abi: [...passportMerchantAbi, ...errors],
          functionName: "pay",
          args: [toHex(crypto.getRandomValues(new Uint8Array(32))), intent, presentation, signature],
          gas,
        });
  const receipt = await ctx.client.waitForTransactionReceipt({ hash });
  const ok = receipt.status === "success";
  return {
    executed: ok,
    stoppedBy: ok ? undefined : "on-chain",
    reason: ok ? "Ok" : pre.reason,
    txHash: hash,
    txUrl: `${ctx.explorer}/tx/${hash}`,
    status: receipt.status,
    block: receipt.blockNumber.toString(),
  };
}
