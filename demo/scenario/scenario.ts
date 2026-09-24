import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  maxUint256,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import {
  MONAD_TESTNET,
  agentIdentityRegistryAbi,
  buildIntent,
  buildRegistrationFile,
  credentialStatusRegistryAbi,
  gateClaimNames,
  issueCredential,
  listClaims,
  mockTokenAbi,
  passportDexAbi,
  passportGateAbi,
  passportMerchantAbi,
  reasonToBytes32,
  serializeCredential,
  deserializeCredential,
  signIntent,
  toDataUri,
  toGatePresentation,
  type HeldCredential,
} from "@agent-passport/sdk";
import { actors, repoRoot } from "./env.js";
import type { Role, RunLog, StepLog } from "./types.js";

const C = MONAD_TESTNET;
const CHAIN_ID = 10143;
const EXPLORER = "https://testnet.monadscan.com";
const USD = (n: number) => BigInt(Math.round(n * 1e6));
const gateErrors = passportGateAbi.filter((x) => x.type === "error");
const stateDir = join(repoRoot, "demo", ".state");

function decodeRevert(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data) {
      if (r.data.errorName === "NotAuthorized") {
        const REASONS = [
          "Ok", "UnknownCredential", "Revoked", "Expired", "NotYetValid", "Superseded", "IssuerNotOwner",
          "WrongAgent", "BadDisclosure", "ScopeNotGranted", "AssetNotGranted", "PayeeNotAllowed",
          "ExceedsPerTxLimit", "ExceedsDailyLimit", "OwnerNotVleiVerified",
        ];
        return REASONS[Number(r.data.args?.[0])] ?? "NotAuthorized";
      }
      return r.data.errorName;
    }
    return e.shortMessage;
  }
  return String(e);
}

/**
 * The Agent Passport storyline on Monad testnet. Every on-chain step — including rejected ones — is
 * sent as a real transaction so it is visible on the explorer; rejected actions are pre-flighted with
 * eth_call first to read the gate's reason, then sent with a fixed gas limit.
 */
export class Scenario {
  readonly a = actors();
  agentId?: bigint;
  held?: HeldCredential;
  readonly setup: StepLog[] = [];
  readonly steps: StepLog[] = [];

  constructor(private readonly onStep: (s: StepLog) => void = () => {}) {}

  private async tx(
    role: Role,
    id: string,
    title: string,
    wallet: WalletClient,
    call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
    opts: { expect?: "success" | "rejected"; into?: StepLog[]; detail?: Record<string, string> } = {},
  ): Promise<StepLog & { logs?: unknown[] }> {
    const abi = [...call.abi, ...gateErrors] as Abi;
    const account = wallet.account!;
    let reason: string | undefined;
    let gas: bigint;
    try {
      await this.a.publicClient.simulateContract({ ...call, abi, account } as never);
      gas = ((await this.a.publicClient.estimateContractGas({ ...call, abi, account } as never)) * 125n) / 100n;
    } catch (e) {
      reason = decodeRevert(e);
      gas = 400_000n; // still send it, so the rejection is recorded on-chain
    }
    const started = Date.now();
    const hash = await wallet.writeContract({ ...call, abi, account, chain: wallet.chain, gas } as never);
    const receipt = await this.a.publicClient.waitForTransactionReceipt({ hash });
    const step: StepLog = {
      id,
      role,
      title,
      expect: opts.expect ?? "success",
      outcome: receipt.status === "success" ? "success" : "rejected",
      reason: receipt.status === "success" ? undefined : reason,
      txHash: hash,
      block: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      latencyMs: Date.now() - started,
      detail: opts.detail,
    };
    (opts.into ?? this.steps).push(step);
    this.onStep(step);
    return { ...step, logs: receipt.logs };
  }

  private offchain(role: Role, id: string, title: string, detail: Record<string, string>) {
    const step: StepLog = { id, role, title, expect: "offchain", outcome: "offchain", detail };
    this.steps.push(step);
    this.onStep(step);
  }

  // ------------------------------------------------------------------ setup (idempotent)

  async ensureAgent() {
    const { owner, agent, publicClient } = this.a;
    const statePath = join(stateDir, "agent.json");
    if (existsSync(statePath)) {
      const saved = BigInt(JSON.parse(readFileSync(statePath, "utf8")).agentId);
      const current = await publicClient
        .readContract({ address: C.identityRegistry, abi: agentIdentityRegistryAbi, functionName: "ownerOf", args: [saved] })
        .catch(() => undefined);
      if (current === owner.account!.address) this.agentId = saved;
    }
    if (this.agentId === undefined) {
      const r = await this.tx("owner", "register", "Register the agent (ERC-8004 Identity)", owner, {
        address: C.identityRegistry,
        abi: agentIdentityRegistryAbi,
        functionName: "register",
        args: [],
      }, { into: this.setup });
      const [ev] = parseEventLogs({ abi: agentIdentityRegistryAbi, eventName: "Registered", logs: r.logs as never });
      this.agentId = ev.args.agentId;
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ agentId: this.agentId.toString() }));
    }
    const agentId = this.agentId;

    const wallet = await publicClient.readContract({
      address: C.identityRegistry, abi: agentIdentityRegistryAbi, functionName: "getAgentWallet", args: [agentId],
    });
    if (wallet !== agent.account!.address) {
      const { timestamp } = await publicClient.getBlock();
      const deadline = timestamp + 240n;
      const sig = await agent.account!.signTypedData!({
        domain: { name: "AgentPassportIdentity", version: "1", chainId: CHAIN_ID, verifyingContract: C.identityRegistry },
        types: {
          AgentWalletSet: [
            { name: "agentId", type: "uint256" },
            { name: "newWallet", type: "address" },
            { name: "owner", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "AgentWalletSet",
        message: { agentId, newWallet: agent.account!.address, owner: owner.account!.address, deadline },
      });
      await this.tx("owner", "bind-wallet", "Bind the agent's signing key (signed by the agent)", owner, {
        address: C.identityRegistry,
        abi: agentIdentityRegistryAbi,
        functionName: "setAgentWallet",
        args: [agentId, agent.account!.address, deadline, sig],
      }, { into: this.setup });
    }

    const file = buildRegistrationFile({
      name: "Example Treasury Agent",
      description: "Rebalances an example treasury on Monad within the limits of its Agent Passport.",
      chainId: CHAIN_ID,
      identityRegistry: C.identityRegistry,
      agentId,
      mcpEndpoint: this.a.mcpPublicUrl,
      passportGate: C.passportGate,
    });
    const uri = toDataUri(file);
    const currentUri = await publicClient
      .readContract({ address: C.identityRegistry, abi: agentIdentityRegistryAbi, functionName: "tokenURI", args: [agentId] })
      .catch(() => "");
    if (currentUri !== uri) {
      await this.tx("owner", "registration-file", "Publish the ERC-8004 registration file on-chain (data: URI)", owner, {
        address: C.identityRegistry,
        abi: agentIdentityRegistryAbi,
        functionName: "setAgentURI",
        args: [agentId, uri],
      }, { into: this.setup, detail: { services: file.services.map((s) => s.name).join(", ") } });
    }

    const balance = await publicClient.readContract({
      address: C.demoUsd, abi: mockTokenAbi, functionName: "balanceOf", args: [owner.account!.address],
    });
    if (balance < USD(1_000)) {
      await this.tx("owner", "faucet", "Owner takes demo apUSD from the test faucet", owner, {
        address: C.demoUsd, abi: mockTokenAbi, functionName: "faucet", args: [],
      }, { into: this.setup });
    }
    const allowance = await publicClient.readContract({
      address: C.demoUsd, abi: mockTokenAbi, functionName: "allowance", args: [owner.account!.address, C.passportGate],
    });
    if (allowance < USD(1_000_000)) {
      await this.tx("owner", "approve", "Owner lets PassportGate pull funds (the agent holds none)", owner, {
        address: C.demoUsd, abi: mockTokenAbi, functionName: "approve", args: [C.passportGate, maxUint256],
      }, { into: this.setup });
    }
  }

  // ------------------------------------------------------------------ storyline

  async issue() {
    const { owner, publicClient } = this.a;
    const { timestamp } = await publicClient.getBlock();
    this.held = await issueCredential(
      {
        chainId: CHAIN_ID,
        identityRegistry: C.identityRegistry,
        statusRegistry: C.credentialStatusRegistry,
        agentId: this.agentId!,
        issuer: owner.account!.address,
        scopes: ["dex.swap", "commerce.pay"],
        limits: [{ asset: C.demoUsd, maxPerTx: USD(100), dailyLimit: USD(250), symbol: "apUSD" }],
        payees: [C.passportDex, C.passportMerchant],
        validFrom: timestamp - 60n,
        validUntil: timestamp + 30n * 86_400n,
        text: { purpose: "Treasury rebalancing", ownerName: "Example Treasury Ltd", mandateRef: "TRS-2026-017" },
      },
      owner,
    );
    this.offchain("owner", "sign", "Owner signs the authorization credential (EIP-712, off-chain)", {
      credentialId: this.held.credentialId,
      claims: String(this.held.claims.length),
      root: this.held.authorization.disclosureRoot,
    });
    const a = this.held.authorization;
    await this.tx("owner", "anchor", "Anchor the credential hash and disclosure root on Monad", owner, {
      address: C.credentialStatusRegistry,
      abi: credentialStatusRegistryAbi,
      functionName: "anchor",
      args: [this.held.credentialId, a.agentId, a.disclosureRoot, a.validFrom, a.validUntil],
    });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "credential.json"), serializeCredential(this.held));
    // The agent-side MCP server reads its credentials from here.
    mkdirSync(join(repoRoot, "mcp-server", "credentials"), { recursive: true });
    writeFileSync(join(repoRoot, "mcp-server", "credentials", `agent-${a.agentId}.json`), serializeCredential(this.held));
  }

  loadCredential() {
    this.held = deserializeCredential(readFileSync(join(stateDir, "credential.json"), "utf8"));
    this.agentId = this.held.authorization.agentId;
  }

  async swap(id: string, title: string, amount: number, opts: { dex?: Address; expect?: "success" | "rejected" } = {}) {
    const dex = opts.dex ?? C.passportDex;
    const agent = this.a.agent;
    const { timestamp: now } = await this.a.publicClient.getBlock(); // chain time, not the local clock
    const intent = buildIntent({ credentialId: this.held!.credentialId, scope: "dex.swap", asset: C.demoUsd, amount: USD(amount), relyingParty: dex, now });
    const signature = await signIntent(agent.account as never, CHAIN_ID, C.passportGate, intent);
    // The agent can only present claims for the payees in its credential; for a look-alike DEX it
    // presents the real DEX's payee claim, which the gate rejects for this relying party.
    const presentation = toGatePresentation(this.held!, { scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex });
    return this.tx("agent", id, title, agent, {
      address: dex,
      abi: passportDexAbi,
      functionName: "swap",
      args: [intent, presentation, signature, 0n],
    }, { expect: opts.expect, detail: { amount: `${amount} apUSD`, relyingParty: dex } });
  }

  async pay(id: string, title: string, amount: number, expect: "success" | "rejected") {
    const agent = this.a.agent;
    const { timestamp: now } = await this.a.publicClient.getBlock(); // chain time, not the local clock
    const intent = buildIntent({ credentialId: this.held!.credentialId, scope: "commerce.pay", asset: C.demoUsd, amount: USD(amount), relyingParty: C.passportMerchant, now });
    const signature = await signIntent(agent.account as never, CHAIN_ID, C.passportGate, intent);
    const presentation = toGatePresentation(this.held!, { scope: "commerce.pay", asset: C.demoUsd, relyingParty: C.passportMerchant });
    const orderId = `0x${Buffer.from(`order-${Date.now()}`).toString("hex").padEnd(64, "0")}` as Hex;
    return this.tx("agent", id, title, agent, {
      address: C.passportMerchant,
      abi: passportMerchantAbi,
      functionName: "pay",
      args: [orderId, intent, presentation, signature],
    }, { expect, detail: { amount: `${amount} apUSD`, relyingParty: C.passportMerchant } });
  }

  async recordVlei() {
    // Stand-in for the off-chain vLEI verifier service (see docs/VLEI_SETUP.md): it has checked the
    // owner's role credential chain and records only the result plus the role credential's SAID hash.
    return this.tx("vlei", "vlei", "vLEI verifier records: owner is a verified legal entity", this.a.vleiVerifier, {
      address: C.credentialStatusRegistry,
      abi: credentialStatusRegistryAbi,
      functionName: "recordOwnerAssurance",
      args: [this.held!.credentialId, 1, reasonToBytes32("test-OOR-SAID")],
    }, { detail: { note: "test identity; no real LEI" } });
  }

  async revoke() {
    return this.tx("owner", "revoke", "Owner revokes the credential", this.a.owner, {
      address: C.credentialStatusRegistry,
      abi: credentialStatusRegistryAbi,
      functionName: "revoke",
      args: [this.held!.credentialId, reasonToBytes32("owner-revoked")],
    });
  }

  verifierView(): RunLog["verifierView"] {
    const names = gateClaimNames({ scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex });
    const disclosed = names.map((n) => ({ name: n, value: this.held!.claims.find((c) => c.name === n)!.display }));
    return { disclosed, hiddenClaimCount: this.held!.claims.length - disclosed.length };
  }

  report(startedAt: Date): RunLog {
    const lat = this.steps.filter((s) => s.latencyMs).map((s) => s.latencyMs!).sort((x, y) => x - y);
    const revoke = this.steps.find((s) => s.id === "revoke");
    const after = revoke && this.steps.find((s) => s.outcome === "rejected" && BigInt(s.block ?? 0) > BigInt(revoke.block ?? 0));
    const okSwap = this.steps.find((s) => s.id === "swap-ok");
    return {
      version: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      chainId: CHAIN_ID,
      explorer: EXPLORER,
      contracts: { ...C },
      owner: this.a.owner.account!.address,
      agentWallet: this.a.agent.account!.address,
      agentId: this.agentId!.toString(),
      credentialId: this.held!.credentialId,
      verifierView: this.verifierView(),
      ownerClaims: listClaims(this.held!),
      gatePresentations: {
        dex: toGatePresentation(this.held!, { scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex }),
        merchant: toGatePresentation(this.held!, { scope: "commerce.pay", asset: C.demoUsd, relyingParty: C.passportMerchant }),
      },
      setup: this.setup,
      steps: this.steps,
      metrics: {
        medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
        revokeBlock: revoke?.block,
        firstRejectedAfterRevokeBlock: after?.block,
        blocksFromRevokeToRejection: revoke && after ? Number(BigInt(after.block!) - BigInt(revoke.block!)) : undefined,
        successfulSwapGas: okSwap?.gasUsed,
      },
    };
  }
}
