import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Address, Hex } from "viem";
import {
  agentIdentityRegistryAbi,
  anchorCredential,
  credentialStatusRegistryAbi,
  issueCredential,
  mockTokenAbi,
  passportDexAbi,
  passportGateAbi,
  revokeCredential,
  type HeldCredential,
} from "@agent-passport/sdk";
import { deploy, startAnvil } from "../../sdk/test/anvil.js";
import { createPassportServer, type PassportServerConfig } from "../src/server.js";
import { CredentialStore } from "../src/store.js";

let env: Awaited<ReturnType<typeof startAnvil>>;
let client: Client;
let held: HeldCredential;
let base: PassportServerConfig;
const c: Record<string, Address> = {};
const USD = (n: number) => BigInt(n) * 1_000_000n;

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
const callOn = async (cl: Client, name: string, args: Record<string, unknown>) =>
  (await cl.callTool({ name, arguments: args })) as unknown as ToolResult;
const call = (name: string, args: Record<string, unknown>) => callOn(client, name, args);

async function connect(cfg: PassportServerConfig) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createPassportServer(cfg).connect(a);
  const cl = new Client({ name: "test-agent", version: "0" });
  await cl.connect(b);
  return cl;
}

beforeAll(async () => {
  env = await startAnvil(18548);
  const pc = env.publicClient;
  const owner = env.wallet(0);
  const agent = env.wallet(1);
  const wait = (hash: Hex) => pc.waitForTransactionReceipt({ hash });
  const w = (address: Address, abi: never, functionName: string, args: unknown[]) =>
    owner.writeContract({ address, abi, functionName, args, account: owner.account!, chain: env.chain } as never).then(wait);

  c.identity = await deploy(owner, pc as never, "AgentIdentityRegistry", agentIdentityRegistryAbi as never);
  c.status = await deploy(owner, pc as never, "CredentialStatusRegistry", credentialStatusRegistryAbi as never, [c.identity, owner.account!.address]);
  c.gate = await deploy(owner, pc as never, "PassportGate", passportGateAbi as never, [c.identity, c.status]);
  c.usd = await deploy(owner, pc as never, "MockToken", mockTokenAbi as never, ["USD", "USD", 6]);
  c.wmon = await deploy(owner, pc as never, "MockToken", mockTokenAbi as never, ["WMON", "WMON", 18]);
  const zero = "0x0000000000000000000000000000000000000000";
  c.dex = await deploy(owner, pc as never, "PassportDex", passportDexAbi as never, [c.gate, c.usd, c.wmon, 5n * 10n ** 29n, zero]);
  c.otherDex = await deploy(owner, pc as never, "PassportDex", passportDexAbi as never, [c.gate, c.usd, c.wmon, 5n * 10n ** 29n, zero]);

  await w(c.wmon, mockTokenAbi as never, "mint", [c.dex, 10n ** 24n]);
  await w(c.usd, mockTokenAbi as never, "mint", [owner.account!.address, USD(10_000)]);
  await w(c.usd, mockTokenAbi as never, "approve", [c.gate, 2n ** 256n - 1n]);
  await w(c.identity, agentIdentityRegistryAbi as never, "register", ["http://localhost:8788/mcp"]);

  const { timestamp } = await pc.getBlock();
  const sig = await agent.account!.signTypedData!({
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
    message: { agentId: 1n, newWallet: agent.account!.address, owner: owner.account!.address, deadline: timestamp + 60n },
  });
  await w(c.identity, agentIdentityRegistryAbi as never, "setAgentWallet", [1n, agent.account!.address, timestamp + 60n, sig]);

  held = await issueCredential(
    {
      chainId: 31337,
      identityRegistry: c.identity,
      statusRegistry: c.status,
      agentId: 1n,
      issuer: owner.account!.address,
      scopes: ["dex.swap"],
      limits: [{ asset: c.usd, maxPerTx: USD(100), dailyLimit: USD(250) }],
      payees: [c.dex],
      validFrom: timestamp,
      validUntil: timestamp + 86_400n,
      text: { purpose: "Treasury rebalancing", ownerName: "Example Treasury Ltd" },
    },
    owner,
  );
  await wait(await anchorCredential(owner, c.status, held));

  base = {
    client: pc as never,
    gate: c.gate,
    statusRegistry: c.status,
    defaults: { asset: c.usd, relyingParty: c.dex, relyingParties: { "dex.swap": c.dex } },
    store: new CredentialStore([held]),
    actions: {
      client: pc as never,
      chain: env.chain,
      rpcUrl: env.chain.rpcUrls.default.http[0],
      gate: c.gate,
      identityRegistry: c.identity,
      agent: env.account(1),
      explorer: "http://explorer.local",
    },
  };
  client = await connect(base);
}, 120_000);

afterAll(() => env?.proc.kill());

describe("MCP tools (agent mode)", () => {
  it("lists four tools with output schemas and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_authorization", "execute_action", "present_passport", "verify_passport"]);
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
    const exec = tools.find((t) => t.name === "execute_action")!;
    expect(exec.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === "check_authorization")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(client.getInstructions()).toMatch(/refusal is final/);
  });

  it("present_passport lists claims with what the policy allows", async () => {
    const list = await call("present_passport", { agentId: "1", disclose: [] });
    const claims = list.structuredContent?.availableClaims as { name: string; disclosable: boolean }[];
    expect(claims.find((x) => x.name === "text:ownerName")).toEqual({ name: "text:ownerName", disclosable: false });
    expect(claims.find((x) => x.name === "scope:dex.swap")?.disclosable).toBe(true);
  });

  it("present_passport discloses allowed claims and refuses private ones", async () => {
    const r = await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap"] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).not.toContain("Example Treasury Ltd");
    expect(r.structuredContent?.hiddenClaimCount).toBe(5);

    const refused = await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap", "text:ownerName"] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/refused by this agent's disclosure policy: text:ownerName/);
  });

  it("an operator can widen the policy explicitly", async () => {
    const cl = await connect({ ...base, policy: { allow: ["scope:*", "text:purpose"] } });
    const r = await callOn(cl, "present_passport", { agentId: "1", disclose: ["text:purpose"] });
    expect(r.isError).toBeFalsy();
    const x = await callOn(cl, "present_passport", { agentId: "1", disclose: [`maxPerTx:${c.usd.toLowerCase()}`] });
    expect(x.isError).toBe(true);
  });

  it("rejects malformed arguments at the protocol level", async () => {
    const r = await call("check_authorization", { agentId: "one", scope: "dex.swap", amount: "1" });
    expect(r.isError).toBe(true);
  });

  it("verify_passport accepts a genuine presentation and enforces the required scope", async () => {
    const pres = (await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap"] })).structuredContent!.presentation;
    const good = await call("verify_passport", { presentation: pres as Record<string, unknown>, requiredScope: "dex.swap" });
    expect(good.structuredContent).toMatchObject({ valid: true, agentId: "1", revealed: { "scope:dex.swap": "dex.swap" } });
    const missing = await call("verify_passport", { presentation: JSON.stringify(pres), requiredScope: "lending.borrow" });
    expect(missing.structuredContent?.valid).toBe(false);
  });

  it("check_authorization reads the gate's verdict", async () => {
    expect((await call("check_authorization", { agentId: "1", scope: "dex.swap", amount: "80000000" })).structuredContent).toMatchObject({
      authorized: true,
      reason: "Ok",
      credentialStatus: "Active",
    });
    expect((await call("check_authorization", { agentId: "1", scope: "dex.swap", amount: "150000000" })).structuredContent).toMatchObject({
      authorized: false,
      reason: "ExceedsPerTxLimit",
    });
    expect((await call("check_authorization", { agentId: "1", scope: "commerce.pay", amount: "1" })).structuredContent).toMatchObject({
      authorized: false,
      reason: "NotInCredential",
    });
  });

  it("execute_action: within the mandate → sent and settled", async () => {
    const r = await call("execute_action", { agentId: "1", scope: "dex.swap", amount: "80000000" });
    expect(r.structuredContent).toMatchObject({ executed: true, reason: "Ok", status: "success" });
    expect(r.structuredContent?.txUrl).toMatch(/^http:\/\/explorer\.local\/tx\/0x/);
  });

  it("execute_action: over the limit → stopped by the pre-flight, nothing sent", async () => {
    const before = await env.publicClient.getTransactionCount({ address: env.account(1).address });
    const r = await call("execute_action", { agentId: "1", scope: "dex.swap", amount: "150000000" });
    expect(r.structuredContent).toMatchObject({ executed: false, stoppedBy: "pre-flight", reason: "ExceedsPerTxLimit" });
    expect(await env.publicClient.getTransactionCount({ address: env.account(1).address })).toBe(before);
  });

  it("execute_action with forceSubmit → the gate reverts it on-chain", async () => {
    const r = await call("execute_action", { agentId: "1", scope: "dex.swap", amount: "150000000", forceSubmit: true });
    expect(r.structuredContent).toMatchObject({ executed: false, stoppedBy: "on-chain", status: "reverted", reason: "ExceedsPerTxLimit" });
  });

  it("execute_action: a counterparty outside the mandate (e.g. injected) → refused", async () => {
    const r = await call("execute_action", { agentId: "1", scope: "dex.swap", amount: "1000000", relyingParty: c.otherDex });
    expect(r.structuredContent).toMatchObject({ executed: false, stoppedBy: "mandate" });
    const forced = await call("execute_action", { agentId: "1", scope: "dex.swap", amount: "1000000", relyingParty: c.otherDex, forceSubmit: true });
    expect(forced.structuredContent).toMatchObject({ executed: false, stoppedBy: "on-chain", reason: "PayeeNotAllowed" });
  });

  it("execute_action refuses to sign with a key that is not the agent's wallet", async () => {
    const cl = await connect({ ...base, actions: { ...base.actions!, agent: env.account(2) } });
    const r = await callOn(cl, "execute_action", { agentId: "1", scope: "dex.swap", amount: "1" });
    expect(r.structuredContent).toMatchObject({ executed: false, stoppedBy: "mandate" });
  });

  it("after revocation every path says no", async () => {
    await env.publicClient.waitForTransactionReceipt({ hash: await revokeCredential(env.wallet(0), c.status, held.credentialId, "mcp-test") });
    expect((await call("check_authorization", { agentId: "1", scope: "dex.swap", amount: "1" })).structuredContent).toMatchObject({
      authorized: false,
      reason: "Revoked",
    });
    expect((await call("execute_action", { agentId: "1", scope: "dex.swap", amount: "1" })).structuredContent).toMatchObject({
      executed: false,
      reason: "Revoked",
    });
    const pres = (await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap"] })).structuredContent!.presentation;
    expect((await call("verify_passport", { presentation: pres as Record<string, unknown> })).structuredContent?.valid).toBe(false);
  });
});

describe("MCP tools (verifier-only mode)", () => {
  it("exposes no agent-side actions and refuses to present", async () => {
    const cl = await connect({ ...base, store: undefined, actions: undefined });
    const { tools } = await cl.listTools();
    expect(tools.map((t) => t.name)).toEqual(["verify_passport"]);
  });
});
