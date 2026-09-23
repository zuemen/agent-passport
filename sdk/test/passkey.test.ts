import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import {
  agentIdentityRegistryAbi,
  credentialStatusRegistryAbi,
  createPresentation,
  executeDigest,
  hexToBytes32,
  issueCredential,
  mockTokenAbi,
  parseDerSignature,
  passkeyAccountAbi,
  passkeyAccountFactoryAbi,
  passkeyCall,
  passkeyTypedDataSigner,
  passportGateAbi,
  toWebAuthnAuth,
  verifyPresentation,
  type PasskeyCall,
} from "../src/index.js";
import { deploy, startAnvil } from "./anvil.js";
import { SoftPasskey } from "./softPasskey.js";

/**
 * Owner = a passkey. One biometric prompt signs the mandate (ERC-1271 issuer), another executes the
 * whole on-chain setup in one batch; a third revokes. A relayer pays the gas.
 */
let env: Awaited<ReturnType<typeof startAnvil>>;
const c: Record<string, Address> = {};
let account: Address;
const passkey = SoftPasskey.generate();

async function execute(calls: PasskeyCall[]) {
  const { timestamp } = await env.publicClient.getBlock();
  const deadline = timestamp + 300n;
  const { digest } = await executeDigest(env.publicClient as never, account, calls, deadline);
  const auth = toWebAuthnAuth(await passkey.sign(hexToBytes32(digest)));
  const relayer = env.wallet(5);
  const hash = await relayer.writeContract({
    address: account,
    abi: passkeyAccountAbi,
    functionName: "execute",
    args: [calls, deadline, auth],
    account: relayer.account!,
    chain: env.chain,
  });
  return env.publicClient.waitForTransactionReceipt({ hash });
}

beforeAll(async () => {
  env = await startAnvil(18549);
  const pc = env.publicClient;
  const d = env.wallet(0);
  c.identity = await deploy(d, pc as never, "AgentIdentityRegistry", agentIdentityRegistryAbi as never);
  c.status = await deploy(d, pc as never, "CredentialStatusRegistry", credentialStatusRegistryAbi as never, [c.identity, d.account!.address]);
  c.gate = await deploy(d, pc as never, "PassportGate", passportGateAbi as never, [c.identity, c.status]);
  c.usd = await deploy(d, pc as never, "MockToken", mockTokenAbi as never, ["USD", "USD", 6]);
  c.factory = await deploy(d, pc as never, "PasskeyAccountFactory", passkeyAccountFactoryAbi as never);
  const hash = await d.writeContract({
    address: c.factory,
    abi: passkeyAccountFactoryAbi,
    functionName: "create",
    args: [passkey.x, passkey.y, "0x" + "00".repeat(32) as Hex],
    account: d.account!,
    chain: env.chain,
  });
  const r = await pc.waitForTransactionReceipt({ hash });
  account = parseEventLogs({ abi: passkeyAccountFactoryAbi, logs: r.logs })[0].args.account;
}, 120_000);

afterAll(() => env?.proc.kill());

describe("passkey owner", () => {
  it("DER parsing normalises s into the lower half", async () => {
    const a = await passkey.sign(new Uint8Array(32));
    const { s } = parseDerSignature(a.signature);
    expect(BigInt(s) <= 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n).toBe(true);
  });

  it("one prompt sets up the agent; the mandate is signed by the passkey (ERC-1271) and verifies", async () => {
    const agentId = 1n;
    const { timestamp } = await env.publicClient.getBlock();
    const held = await issueCredential(
      {
        chainId: 31337,
        identityRegistry: c.identity,
        statusRegistry: c.status,
        agentId,
        issuer: account,
        scopes: ["dex.swap"],
        limits: [{ asset: c.usd, maxPerTx: 100_000_000n, dailyLimit: 250_000_000n }],
        payees: [c.usd],
        validFrom: timestamp,
        validUntil: timestamp + 86_400n,
      },
      passkeyTypedDataSigner(account, (ch) => passkey.sign(ch)),
    );
    const a = held.authorization;
    const receipt = await execute([
      passkeyCall(c.identity, agentIdentityRegistryAbi, "register", ["ipfs://passkey-agent"]),
      passkeyCall(c.usd, mockTokenAbi, "faucet", []),
      passkeyCall(c.usd, mockTokenAbi, "approve", [c.gate, maxUint256]),
      passkeyCall(c.status, credentialStatusRegistryAbi, "anchor", [held.credentialId, a.agentId, a.disclosureRoot, a.validFrom, a.validUntil]),
    ]);
    expect(receipt.status).toBe("success");
    expect(await env.publicClient.readContract({ address: c.identity, abi: agentIdentityRegistryAbi, functionName: "ownerOf", args: [agentId] })).toBe(account);

    const v = await verifyPresentation(createPresentation(held, ["scope:dex.swap"]), { client: env.publicClient as never });
    expect(v.errors).toEqual([]);
    expect(v.onchain?.status).toBe("Active");

    const rev = await execute([passkeyCall(c.status, credentialStatusRegistryAbi, "revoke", [held.credentialId, "0x" + "00".repeat(32)])]);
    expect(rev.status).toBe("success");
    expect((await verifyPresentation(createPresentation(held, []), { client: env.publicClient as never })).onchain?.status).toBe("Revoked");
  });

  it("a signature from another passkey is rejected", async () => {
    const other = SoftPasskey.generate();
    const calls = [passkeyCall(c.identity, agentIdentityRegistryAbi, "register", [""])];
    const { timestamp } = await env.publicClient.getBlock();
    const { digest } = await executeDigest(env.publicClient as never, account, calls, timestamp + 60n);
    const auth = toWebAuthnAuth(await other.sign(hexToBytes32(digest)));
    await expect(
      env.publicClient.simulateContract({
        address: account,
        abi: passkeyAccountAbi,
        functionName: "execute",
        args: [calls, timestamp + 60n, auth],
        account: env.account(5),
      }),
    ).rejects.toThrow(/InvalidPasskeySignature/);
  });
});
