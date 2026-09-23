import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import {
  MONAD_TESTNET as C,
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
  REASONS,
  signIntent,
  toGatePresentation,
  toWebAuthnAuth,
  type PasskeyCall,
} from "@agent-passport/sdk";
import { SoftPasskey } from "../../sdk/test/softPasskey.js";
import { actors, repoRoot } from "./env.js";

/**
 * npm run passkey -w demo — the owner is a passkey-controlled smart account (P-256, verified on-chain
 * via Monad's 0x0100 precompile). A relayer pays gas; the owner never holds MON or a seed phrase.
 *   1 prompt: sign the mandate (ERC-1271 issuer)
 *   1 prompt: register agent + bind agent key + take test funds + approve gate + anchor mandate
 *   agent swaps with the passkey account's funds
 *   1 prompt: revoke  → next swap rejected
 */
const a = actors();
const relayer = a.vleiVerifier; // the deployer key pays gas for relayed passkey calls
const pc = a.publicClient;
const stateDir = join(repoRoot, "demo", ".state");
const log: { step: string; tx?: string; block?: string; status?: string; reason?: string }[] = [];
const say = (step: string, r?: { transactionHash: Hex; blockNumber: bigint; status: string }, reason?: string) => {
  log.push({ step, tx: r?.transactionHash, block: r?.blockNumber.toString(), status: r?.status, reason });
  console.log(`${r ? (r.status === "success" ? "✅" : "❌") : "✍️ "} ${step}${reason ? ` — ${reason}` : ""}`);
  if (r) console.log(`   https://testnet.monadscan.com/tx/${r.transactionHash}`);
};

mkdirSync(stateDir, { recursive: true });
const keyFile = join(stateDir, "passkey.pem");
const passkey = existsSync(keyFile) ? SoftPasskey.fromPem(readFileSync(keyFile, "utf8")) : SoftPasskey.generate();
writeFileSync(keyFile, passkey.toPem());

const salt = ("0x" + "00".repeat(31) + "01") as Hex;
const account = (await pc.readContract({
  address: C.passkeyAccountFactory,
  abi: passkeyAccountFactoryAbi,
  functionName: "predict",
  args: [passkey.x, passkey.y, salt],
})) as Address;
const existing = await pc.getCode({ address: account });
if (!existing || existing === "0x") {
  const hash = await relayer.writeContract({
    address: C.passkeyAccountFactory,
    abi: passkeyAccountFactoryAbi,
    functionName: "create",
    args: [passkey.x, passkey.y, salt],
    account: relayer.account!,
    chain: relayer.chain,
  });
  say("Create the owner's passkey account (CREATE2, relayed)", await pc.waitForTransactionReceipt({ hash }));
}
console.log(`owner = PasskeyAccount ${account}`);

async function execute(step: string, calls: PasskeyCall[]) {
  const { timestamp } = await pc.getBlock();
  const deadline = timestamp + 300n;
  const { digest } = await executeDigest(pc as never, account, calls, deadline);
  const auth = toWebAuthnAuth(await passkey.sign(hexToBytes32(digest)));
  const hash = await relayer.writeContract({
    address: account,
    abi: passkeyAccountAbi,
    functionName: "execute",
    args: [calls, deadline, auth],
    account: relayer.account!,
    chain: relayer.chain,
  });
  const r = await pc.waitForTransactionReceipt({ hash });
  say(step, r);
  return r;
}

// ---- mandate, signed by the passkey
const agentId = (await pc.readContract({ address: C.identityRegistry, abi: agentIdentityRegistryAbi, functionName: "totalAgents" })) + 1n;
const { timestamp } = await pc.getBlock();
const held = await issueCredential(
  {
    chainId: 10143,
    identityRegistry: C.identityRegistry,
    statusRegistry: C.credentialStatusRegistry,
    agentId,
    issuer: account,
    scopes: ["dex.swap"],
    limits: [{ asset: C.demoUsd, maxPerTx: 50_000_000n, dailyLimit: 100_000_000n }],
    payees: [C.passportDex],
    validFrom: timestamp - 60n,
    validUntil: timestamp + 7n * 86_400n,
    text: { purpose: "Passkey-owned agent demo" },
  },
  passkeyTypedDataSigner(account, (ch) => passkey.sign(ch)),
);
say("Passkey signs the mandate (EIP-712 digest as WebAuthn challenge, ERC-1271 issuer)");

// ---- agent key binding (signed by the agent, names the passkey account as owner)
const agent = a.agent;
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
  message: { agentId, newWallet: agent.account!.address, owner: account, deadline },
});

const au = held.authorization;
const setup = await execute("One passkey prompt: register agent, bind key, fund, approve gate, anchor mandate", [
  passkeyCall(C.identityRegistry, agentIdentityRegistryAbi, "register", ["data:application/json;base64,eyJuYW1lIjoiUGFzc2tleSBBZ2VudCJ9"]),
  passkeyCall(C.identityRegistry, agentIdentityRegistryAbi, "setAgentWallet", [agentId, agent.account!.address, deadline, agentSig]),
  passkeyCall(C.demoUsd, mockTokenAbi, "faucet", []),
  passkeyCall(C.demoUsd, mockTokenAbi, "approve", [C.passportGate, maxUint256]),
  passkeyCall(C.credentialStatusRegistry, credentialStatusRegistryAbi, "anchor", [held.credentialId, au.agentId, au.disclosureRoot, au.validFrom, au.validUntil]),
]);
const registered = parseEventLogs({ abi: agentIdentityRegistryAbi, eventName: "Registered", logs: setup.logs })[0];
if (registered.args.agentId !== agentId) throw new Error(`agent id race: expected ${agentId}, got ${registered.args.agentId}`);

// ---- agent acts with the passkey account's funds
const abi = [...passportDexAbi, ...passportGateAbi.filter((x) => x.type === "error")];
async function swap(step: string, amount: bigint) {
  const intent = buildIntent({ credentialId: held.credentialId, scope: "dex.swap", asset: C.demoUsd, amount, relyingParty: C.passportDex });
  const signature = await signIntent(agent.account as never, 10143, C.passportGate, intent);
  const presentation = toGatePresentation(held, { scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex });
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
  say(step, await pc.waitForTransactionReceipt({ hash }), reason);
}
await swap("Agent swaps 10 apUSD from the passkey owner's funds", 10_000_000n);
await execute("Passkey prompt: revoke the mandate", [
  passkeyCall(C.credentialStatusRegistry, credentialStatusRegistryAbi, "revoke", [held.credentialId, reasonToBytes32("passkey-revoke")]),
]);
await swap("Agent swaps 10 apUSD after the passkey revocation", 10_000_000n);

writeFileSync(
  join(repoRoot, "demo", "public", "runs", "passkey-latest.json"),
  JSON.stringify({ at: new Date().toISOString(), owner: account, agentId: agentId.toString(), credentialId: held.credentialId, steps: log }, null, 2),
);
