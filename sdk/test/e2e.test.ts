import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import {
  agentIdentityRegistryAbi,
  agentReputationRegistryAbi,
  anchorCredential,
  buildIntent,
  checkAuthorization,
  createPresentation,
  credentialStatus,
  credentialStatusRegistryAbi,
  groundedFeedbackAbi,
  issueCredential,
  mockTokenAbi,
  passportDexAbi,
  passportGateAbi,
  passportMerchantAbi,
  revokeCredential,
  signIntent,
  toGatePresentation,
  verifyPresentation,
  type HeldCredential,
} from "../src/index.js";
import { deploy, startAnvil } from "./anvil.js";

/**
 * The demo storyline against real contracts on a local chain:
 * within limit → settles; over limit → rejected; vLEI-gated merchant → rejected until the owner is
 * verified; owner revokes → the next action is rejected.
 */
let env: Awaited<ReturnType<typeof startAnvil>>;
const c: Record<string, Address> = {};
let agentId: bigint;
let held: HeldCredential;

const USD = (n: number) => BigInt(n) * 1_000_000n;

beforeAll(async () => {
  env = await startAnvil(18547);
  const { publicClient: pc } = env;
  const owner = env.wallet(0);
  const agentWallet = env.wallet(1);
  const d = (name: string, abi: never, args: unknown[] = []) => deploy(owner, pc as never, name, abi, args);
  const wait = (hash: Hex) => pc.waitForTransactionReceipt({ hash });

  c.identity = await d("AgentIdentityRegistry", agentIdentityRegistryAbi as never);
  c.status = await d("CredentialStatusRegistry", credentialStatusRegistryAbi as never, [c.identity, owner.account!.address]);
  c.gate = await d("PassportGate", passportGateAbi as never, [c.identity, c.status]);
  c.reputation = await d("AgentReputationRegistry", agentReputationRegistryAbi as never, [c.identity]);
  c.feedback = await d("GroundedFeedback", groundedFeedbackAbi as never, [c.gate, c.reputation]);
  c.usd = await d("MockToken", mockTokenAbi as never, ["USD", "USD", 6]);
  c.wmon = await d("MockToken", mockTokenAbi as never, ["WMON", "WMON", 18]);
  c.dex = await d("PassportDex", passportDexAbi as never, [c.gate, c.usd, c.wmon, 5n * 10n ** 29n, c.feedback]);
  c.merchant = await d("PassportMerchant", passportMerchantAbi as never, [c.gate, owner.account!.address]);

  const w = (address: Address, abi: never, functionName: string, args: unknown[]) =>
    owner.writeContract({ address, abi, functionName, args, account: owner.account!, chain: env.chain } as never).then(wait);

  await w(c.wmon, mockTokenAbi as never, "mint", [c.dex, 10n ** 24n]);
  await w(c.usd, mockTokenAbi as never, "mint", [owner.account!.address, USD(10_000)]);
  await w(c.usd, mockTokenAbi as never, "approve", [c.gate, 2n ** 256n - 1n]);
  await w(c.status, credentialStatusRegistryAbi as never, "setVleiVerifier", [owner.account!.address, true]);

  // Register the agent (ERC-8004) and bind its wallet with the wallet's own signature.
  const { result } = await pc.simulateContract({
    address: c.identity,
    abi: agentIdentityRegistryAbi,
    functionName: "register",
    args: ["ipfs://agent-card"],
    account: owner.account!,
  });
  agentId = result;
  await w(c.identity, agentIdentityRegistryAbi as never, "register", ["ipfs://agent-card"]);
  const block = await pc.getBlock();
  const deadline = block.timestamp + 60n;
  const sig = await agentWallet.account!.signTypedData!({
    domain: { name: "AgentPassportIdentity", version: "1", chainId: 31337, verifyingContract: c.identity },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: { agentId, newWallet: agentWallet.account!.address, owner: owner.account!.address, deadline },
  });
  await w(c.identity, agentIdentityRegistryAbi as never, "setAgentWallet", [agentId, agentWallet.account!.address, deadline, sig]);

  held = await issueCredential(
    {
      chainId: 31337,
      identityRegistry: c.identity,
      statusRegistry: c.status,
      agentId,
      issuer: owner.account!.address,
      scopes: ["dex.swap", "commerce.pay"],
      limits: [{ asset: c.usd, maxPerTx: USD(100), dailyLimit: USD(250) }],
      payees: [c.dex, c.merchant],
      validFrom: block.timestamp,
      validUntil: block.timestamp + 30n * 86_400n,
      text: { purpose: "Treasury rebalancing", ownerName: "Example Treasury Ltd" },
    },
    owner,
  );
  await wait(await anchorCredential(owner, c.status, held));
}, 120_000);

afterAll(() => {
  env?.proc.kill();
});

async function swap(amount: bigint) {
  const agent = env.account(1);
  const intent = buildIntent({ credentialId: held.credentialId, scope: "dex.swap", asset: c.usd, amount, relyingParty: c.dex });
  const signature = await signIntent(agent, 31337, c.gate, intent);
  const presentation = toGatePresentation(held, { scope: "dex.swap", asset: c.usd, relyingParty: c.dex });
  return env.wallet(1).writeContract({
    address: c.dex,
    abi: passportDexAbi,
    functionName: "swap",
    args: [intent, presentation, signature, 0n],
    account: agent,
    chain: env.chain,
    gas: 1_500_000n, // fixed so a rejected action still lands on-chain as a failed tx
  });
}

function revertReason(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!(r instanceof ContractFunctionRevertedError)) return undefined;
  return `${r.data?.errorName}(${(r.data?.args ?? []).join(",")})`;
}

describe("Agent Passport end to end", () => {
  it("verifier sees only disclosed claims and the credential is Active on-chain", async () => {
    const p = createPresentation(held, ["scope:dex.swap", `maxPerTx:${c.usd.toLowerCase()}`]);
    const r = await verifyPresentation(p, { client: env.publicClient as never });
    expect(r.errors).toEqual([]);
    expect(r.onchain).toEqual({ status: "Active", ownerAssurance: "NONE" });
    expect(Object.keys(r.revealed)).toHaveLength(2);
  });

  it("within limit → settles; owner pays and receives, agent holds nothing", async () => {
    const pre = toGatePresentation(held, { scope: "dex.swap", asset: c.usd, relyingParty: c.dex });
    const q = await checkAuthorization(env.publicClient as never, c.gate, {
      agentId,
      scope: "dex.swap",
      asset: c.usd,
      amount: USD(80),
      relyingParty: c.dex,
      presentation: pre,
    });
    expect(q).toEqual({ authorized: true, reason: "Ok" });

    const receipt = await env.publicClient.waitForTransactionReceipt({ hash: await swap(USD(80)) });
    expect(receipt.status).toBe("success");
    const bal = (token: Address, who: Address) =>
      env.publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: "balanceOf", args: [who] });
    expect(await bal(c.wmon, env.account(0).address)).toBe(40n * 10n ** 18n);
    expect(await bal(c.usd, env.account(1).address)).toBe(0n);
  });

  it("over the per-tx limit → rejected with a reason", async () => {
    const pre = toGatePresentation(held, { scope: "dex.swap", asset: c.usd, relyingParty: c.dex });
    const q = await checkAuthorization(env.publicClient as never, c.gate, {
      agentId,
      scope: "dex.swap",
      asset: c.usd,
      amount: USD(150),
      relyingParty: c.dex,
      presentation: pre,
    });
    expect(q.reason).toBe("ExceedsPerTxLimit");

    const hash = await swap(USD(150));
    const receipt = await env.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted"); // visible on-chain as a failed transaction
  });

  it("vLEI-gated merchant rejects until the owner is verified", async () => {
    const pre = toGatePresentation(held, { scope: "commerce.pay", asset: c.usd, relyingParty: c.merchant });
    const ask = () =>
      checkAuthorization(env.publicClient as never, c.gate, {
        agentId,
        scope: "commerce.pay",
        asset: c.usd,
        amount: USD(5),
        relyingParty: c.merchant,
        presentation: pre,
      });
    expect((await ask()).reason).toBe("OwnerNotVleiVerified");

    const owner = env.wallet(0);
    await env.publicClient.waitForTransactionReceipt({
      hash: await owner.writeContract({
        address: c.status,
        abi: credentialStatusRegistryAbi,
        functionName: "recordOwnerAssurance",
        args: [held.credentialId, 1, "0x" + "ab".repeat(32) as Hex],
        account: owner.account!,
        chain: env.chain,
      }),
    });
    expect((await ask()).reason).toBe("Ok");
    expect((await credentialStatus(env.publicClient as never, c.status, held.credentialId)).ownerAssurance).toBe("VLEI_VERIFIED");
  });

  it("owner revokes → the very next action is rejected", async () => {
    const owner = env.wallet(0);
    await env.publicClient.waitForTransactionReceipt({ hash: await revokeCredential(owner, c.status, held.credentialId, "demo") });

    // Pre-flight with a properly signed action: the revert decodes to the gate's reason.
    const agent = env.account(1);
    const intent = buildIntent({ credentialId: held.credentialId, scope: "dex.swap", asset: c.usd, amount: USD(1), relyingParty: c.dex });
    const signature = await signIntent(agent, 31337, c.gate, intent);
    try {
      await env.publicClient.simulateContract({
        address: c.dex,
        abi: [...passportDexAbi, ...passportGateAbi.filter((x) => x.type === "error")],
        functionName: "swap",
        args: [intent, toGatePresentation(held, { scope: "dex.swap", asset: c.usd, relyingParty: c.dex }), signature, 0n],
        account: agent,
      });
      expect.unreachable();
    } catch (e) {
      expect(revertReason(e)).toBe("NotAuthorized(2)"); // Reason.Revoked
    }
    const receipt = await env.publicClient.waitForTransactionReceipt({ hash: await swap(USD(1)) });
    expect(receipt.status).toBe("reverted");

    const r = await verifyPresentation(createPresentation(held, ["scope:dex.swap"]), { client: env.publicClient as never });
    expect(r.valid).toBe(false);
    expect(r.onchain?.status).toBe("Revoked");
  });
});
