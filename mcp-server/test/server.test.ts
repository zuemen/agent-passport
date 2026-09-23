import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Address, Hex } from "viem";
import {
  agentIdentityRegistryAbi,
  anchorCredential,
  credentialStatusRegistryAbi,
  issueCredential,
  passportGateAbi,
  revokeCredential,
  type HeldCredential,
} from "@agent-passport/sdk";
import { deploy, startAnvil } from "../../sdk/test/anvil.js";
import { createPassportServer } from "../src/server.js";
import { CredentialStore } from "../src/store.js";

let env: Awaited<ReturnType<typeof startAnvil>>;
let client: Client;
let held: HeldCredential;
const c: Record<string, Address> = {};
const USD = "0x00000000000000000000000000000000000000aa" as Address;
const DEX = "0x00000000000000000000000000000000000000dd" as Address;

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

beforeAll(async () => {
  env = await startAnvil(18548);
  const pc = env.publicClient;
  const owner = env.wallet(0);
  const wait = (hash: Hex) => pc.waitForTransactionReceipt({ hash });
  c.identity = await deploy(owner, pc as never, "AgentIdentityRegistry", agentIdentityRegistryAbi as never);
  c.status = await deploy(owner, pc as never, "CredentialStatusRegistry", credentialStatusRegistryAbi as never, [
    c.identity,
    owner.account!.address,
  ]);
  c.gate = await deploy(owner, pc as never, "PassportGate", passportGateAbi as never, [c.identity, c.status]);
  // The owner registers the agent; the registrant is the initial agent wallet (fine for a read-only check).
  await wait(
    await owner.writeContract({
      address: c.identity,
      abi: agentIdentityRegistryAbi,
      functionName: "register",
      args: ["http://localhost:8788/mcp"],
      account: owner.account!,
      chain: env.chain,
    }),
  );
  const { timestamp } = await pc.getBlock();
  held = await issueCredential(
    {
      chainId: 31337,
      identityRegistry: c.identity,
      statusRegistry: c.status,
      agentId: 1n,
      issuer: owner.account!.address,
      scopes: ["dex.swap"],
      limits: [{ asset: USD, maxPerTx: 100_000_000n, dailyLimit: 250_000_000n }],
      payees: [DEX],
      validFrom: timestamp,
      validUntil: timestamp + 86_400n,
      text: { purpose: "Treasury rebalancing", ownerName: "Example Treasury Ltd" },
    },
    owner,
  );
  await wait(await anchorCredential(owner, c.status, held));

  const server = createPassportServer({
    client: pc as never,
    gate: c.gate,
    statusRegistry: c.status,
    defaults: { asset: USD, relyingParty: DEX },
    store: new CredentialStore([held]),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test-agent", version: "0" });
  await client.connect(b);
}, 120_000);

afterAll(() => env?.proc.kill());

describe("MCP tools", () => {
  it("lists the three tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_authorization", "present_passport", "verify_passport"]);
  });

  it("present_passport with no names lists claims; with names discloses only those", async () => {
    const list = await call("present_passport", { agentId: "1", disclose: [] });
    expect(list.structuredContent?.availableClaims).toContain("text:ownerName");

    const r = await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap"] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).not.toContain("Example Treasury Ltd");
    expect(r.structuredContent?.hiddenClaimCount).toBe(5);
  });

  it("verify_passport accepts a genuine presentation and enforces the required scope", async () => {
    const pres = (await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap"] })).structuredContent!.presentation;
    const good = await call("verify_passport", { presentation: pres as Record<string, unknown>, requiredScope: "dex.swap" });
    expect(good.structuredContent).toMatchObject({ valid: true, revealed: { "scope:dex.swap": "dex.swap" } });

    const missing = await call("verify_passport", { presentation: JSON.stringify(pres), requiredScope: "lending.borrow" });
    expect(missing.structuredContent?.valid).toBe(false);
  });

  it("check_authorization reads the gate's verdict", async () => {
    const within = await call("check_authorization", { agentId: "1", scope: "dex.swap", amount: "80000000" });
    expect(within.structuredContent).toMatchObject({ authorized: true, reason: "Ok", credentialStatus: "Active" });

    const over = await call("check_authorization", { agentId: "1", scope: "dex.swap", amount: "150000000" });
    expect(over.structuredContent).toMatchObject({ authorized: false, reason: "ExceedsPerTxLimit" });

    const other = await call("check_authorization", { agentId: "1", scope: "bridge.withdraw", amount: "1" });
    expect(other.structuredContent).toMatchObject({ authorized: false, reason: "NotInCredential" });
  });

  it("after revocation both verify_passport and check_authorization say no", async () => {
    await env.publicClient.waitForTransactionReceipt({
      hash: await revokeCredential(env.wallet(0), c.status, held.credentialId, "mcp-test"),
    });
    const r = await call("check_authorization", { agentId: "1", scope: "dex.swap", amount: "1" });
    expect(r.structuredContent).toMatchObject({ authorized: false, reason: "Revoked", credentialStatus: "Revoked" });

    const pres = (await call("present_passport", { agentId: "1", disclose: ["scope:dex.swap"] })).structuredContent!.presentation;
    const v = await call("verify_passport", { presentation: pres as Record<string, unknown> });
    expect(v.structuredContent?.valid).toBe(false);
  });

  it("verifier-only mode refuses to present", async () => {
    const s = createPassportServer({
      client: env.publicClient as never,
      gate: c.gate,
      statusRegistry: c.status,
      defaults: { asset: USD, relyingParty: DEX },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await s.connect(a);
    const cl = new Client({ name: "verifier", version: "0" });
    await cl.connect(b);
    const r = (await cl.callTool({ name: "present_passport", arguments: { agentId: "1", disclose: [] } })) as unknown as ToolResult;
    expect(r.isError).toBe(true);
  });
});
