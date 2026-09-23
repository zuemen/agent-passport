import { maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import {
  MONAD_TESTNET as C,
  REASONS,
  agentIdentityRegistryAbi,
  buildIntent,
  credentialStatusRegistryAbi,
  executeDigest,
  hexToBytes32,
  issueCredential,
  mockTokenAbi,
  passkeyAccountAbi,
  passkeyAccountFactoryAbi,
  passkeyCall,
  passkeyTypedDataSigner,
  passportDexAbi,
  passportGateAbi,
  reasonToBytes32,
  signIntent,
  toGatePresentation,
  toWebAuthnAuth,
  type HeldCredential,
  type PasskeyCall,
  type WebAuthnAssertion,
} from "@agent-passport/sdk";
import { actors } from "./env.js";

export interface PasskeyStep {
  step: string;
  tx?: string;
  block?: string;
  status?: string;
  reason?: string;
}

/** Signs a WebAuthn challenge — a software key in scripts, the user's real passkey in the browser. */
export type PasskeySign = (challenge: Uint8Array, purpose: string) => Promise<WebAuthnAssertion>;

const SALT = ("0x" + "00".repeat(31) + "01") as Hex;

/**
 * The owner is a PasskeyAccount; every owner action is one passkey approval, relayed by the demo
 * relayer (which pays gas). Shared by `npm run passkey` and the demo app's live passkey mode.
 */
export class PasskeyOwnerFlow {
  readonly a = actors();
  readonly steps: PasskeyStep[] = [];
  account?: Address;
  agentId?: bigint;
  held?: HeldCredential;

  constructor(
    private readonly qx: Hex,
    private readonly qy: Hex,
    private readonly sign: PasskeySign,
    private readonly onStep: (s: PasskeyStep) => void = () => {},
  ) {}

  private record(s: PasskeyStep) {
    this.steps.push(s);
    this.onStep(s);
    return s;
  }

  private get relayer() {
    return this.a.vleiVerifier; // deployer key relays passkey calls and pays gas
  }

  async ensureAccount() {
    const pc = this.a.publicClient;
    this.account = (await pc.readContract({
      address: C.passkeyAccountFactory,
      abi: passkeyAccountFactoryAbi,
      functionName: "predict",
      args: [this.qx, this.qy, SALT],
    })) as Address;
    const code = await pc.getCode({ address: this.account });
    if (!code || code === "0x") {
      const hash = await this.relayer.writeContract({
        address: C.passkeyAccountFactory,
        abi: passkeyAccountFactoryAbi,
        functionName: "create",
        args: [this.qx, this.qy, SALT],
        account: this.relayer.account!,
        chain: this.relayer.chain,
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      this.record({ step: "Create the owner's passkey account (CREATE2, relayed)", tx: hash, block: r.blockNumber.toString(), status: r.status });
    }
    return this.account;
  }

  private async execute(step: string, calls: PasskeyCall[]) {
    const pc = this.a.publicClient;
    const { timestamp } = await pc.getBlock();
    const deadline = timestamp + 300n;
    const { digest } = await executeDigest(pc as never, this.account!, calls, deadline);
    const auth = toWebAuthnAuth(await this.sign(hexToBytes32(digest), step));
    const hash = await this.relayer.writeContract({
      address: this.account!,
      abi: passkeyAccountAbi,
      functionName: "execute",
      args: [calls, deadline, auth],
      account: this.relayer.account!,
      chain: this.relayer.chain,
    });
    const r = await pc.waitForTransactionReceipt({ hash });
    this.record({ step, tx: hash, block: r.blockNumber.toString(), status: r.status });
    return r;
  }

  /** Two approvals: sign the mandate, then one batch that registers, binds, funds, approves and anchors. */
  async setup() {
    await this.ensureAccount();
    const pc = this.a.publicClient;
    const agent = this.a.agent;
    this.agentId = (await pc.readContract({ address: C.identityRegistry, abi: agentIdentityRegistryAbi, functionName: "totalAgents" })) + 1n;
    const { timestamp } = await pc.getBlock();
    this.held = await issueCredential(
      {
        chainId: 10143,
        identityRegistry: C.identityRegistry,
        statusRegistry: C.credentialStatusRegistry,
        agentId: this.agentId,
        issuer: this.account!,
        scopes: ["dex.swap"],
        limits: [{ asset: C.demoUsd, maxPerTx: 50_000_000n, dailyLimit: 100_000_000n }],
        payees: [C.passportDex],
        validFrom: timestamp - 60n,
        validUntil: timestamp + 7n * 86_400n,
        text: { purpose: "Passkey-owned agent demo" },
      },
      passkeyTypedDataSigner(this.account!, (ch) => this.sign(ch, "Sign the mandate")),
    );
    this.record({ step: "Passkey signs the mandate (EIP-712 digest as WebAuthn challenge, ERC-1271 issuer)" });

    const deadline = timestamp + 240n;
    const agentSig = await agent.account!.signTypedData!({
      domain: { name: "AgentPassportIdentity", version: "1", chainId: 10143, verifyingContract: C.identityRegistry },
      types: {
        AgentWalletSet: [
          { name: "agentId", type: "uint256" },
          { name: "newWallet", type: "address" },
          { name: "owner", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "AgentWalletSet",
      message: { agentId: this.agentId, newWallet: agent.account!.address, owner: this.account!, deadline },
    });
    const au = this.held.authorization;
    const r = await this.execute("One passkey approval: register agent, bind key, fund, approve gate, anchor mandate", [
      passkeyCall(C.identityRegistry, agentIdentityRegistryAbi, "register", ["data:application/json;base64,eyJuYW1lIjoiUGFzc2tleSBBZ2VudCJ9"]),
      passkeyCall(C.identityRegistry, agentIdentityRegistryAbi, "setAgentWallet", [this.agentId, agent.account!.address, deadline, agentSig]),
      passkeyCall(C.demoUsd, mockTokenAbi, "faucet", []),
      passkeyCall(C.demoUsd, mockTokenAbi, "approve", [C.passportGate, maxUint256]),
      passkeyCall(C.credentialStatusRegistry, credentialStatusRegistryAbi, "anchor", [held(this).credentialId, au.agentId, au.disclosureRoot, au.validFrom, au.validUntil]),
    ]);
    const reg = parseEventLogs({ abi: agentIdentityRegistryAbi, eventName: "Registered", logs: r.logs })[0];
    if (reg && reg.args.agentId !== this.agentId) throw new Error(`agent id race: expected ${this.agentId}, got ${reg.args.agentId}`);
  }

  async swap(step: string, amount: bigint) {
    const pc = this.a.publicClient;
    const agent = this.a.agent;
    const h = held(this);
    const abi = [...passportDexAbi, ...passportGateAbi.filter((x) => x.type === "error")];
    const intent = buildIntent({ credentialId: h.credentialId, scope: "dex.swap", asset: C.demoUsd, amount, relyingParty: C.passportDex });
    const signature = await signIntent(agent.account as never, 10143, C.passportGate, intent);
    const presentation = toGatePresentation(h, { scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex });
    let reason: string | undefined;
    try {
      await pc.simulateContract({ address: C.passportDex, abi, functionName: "swap", args: [intent, presentation, signature, 0n], account: agent.account! });
    } catch (e) {
      const code = (e as Error).message.match(/NotAuthorized\(uint8 reason\)\s*\(([^)]*)\)/)?.[1];
      reason = code !== undefined ? REASONS[Number(code)] : "rejected";
    }
    const hash = await agent.writeContract({
      address: C.passportDex,
      abi,
      functionName: "swap",
      args: [intent, presentation, signature, 0n],
      account: agent.account!,
      chain: agent.chain,
      gas: 700_000n,
    });
    const r = await pc.waitForTransactionReceipt({ hash });
    return this.record({ step, tx: hash, block: r.blockNumber.toString(), status: r.status, reason: r.status === "success" ? undefined : reason });
  }

  async revoke() {
    return this.execute("Passkey approval: revoke the mandate", [
      passkeyCall(C.credentialStatusRegistry, credentialStatusRegistryAbi, "revoke", [held(this).credentialId, reasonToBytes32("passkey-revoke")]),
    ]);
  }
}

function held(f: PasskeyOwnerFlow): HeldCredential {
  if (!f.held) throw new Error("no passkey mandate yet — run setup first");
  return f.held;
}
