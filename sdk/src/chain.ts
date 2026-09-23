import {
  bytesToHex,
  hexToBigInt,
  stringToHex,
  type Account,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { credentialStatusRegistryAbi, passportGateAbi } from "./abi.js";
import { scopeHash } from "./claims.js";
import type { HeldCredential } from "./credential.js";
import type { GatePresentation } from "./presentation.js";

/** Mirrors PassportGate.Reason. */
export const REASONS = [
  "Ok",
  "UnknownCredential",
  "Revoked",
  "Expired",
  "NotYetValid",
  "Superseded",
  "IssuerNotOwner",
  "WrongAgent",
  "BadDisclosure",
  "ScopeNotGranted",
  "AssetNotGranted",
  "PayeeNotAllowed",
  "ExceedsPerTxLimit",
  "ExceedsDailyLimit",
  "OwnerNotVleiVerified",
] as const;
export type Reason = (typeof REASONS)[number];

/** Mirrors CredentialStatusRegistry.Status. */
export const STATUSES = ["Unknown", "Active", "NotYetValid", "Expired", "Revoked", "Superseded", "IssuerNotOwner"] as const;
export type CredentialStatus = (typeof STATUSES)[number];

export const OWNER_ASSURANCE = ["NONE", "VLEI_VERIFIED"] as const;
export type OwnerAssurance = (typeof OWNER_ASSURANCE)[number];

function account(wallet: WalletClient): Account {
  if (!wallet.account) throw new Error("wallet client has no account");
  return wallet.account;
}

/** Owner: put the credential's id and disclosure root on-chain. */
export async function anchorCredential(wallet: WalletClient, statusRegistry: Address, held: HeldCredential) {
  const a = held.authorization;
  return wallet.writeContract({
    address: statusRegistry,
    abi: credentialStatusRegistryAbi,
    functionName: "anchor",
    args: [held.credentialId, a.agentId, a.disclosureRoot, a.validFrom, a.validUntil],
    account: account(wallet),
    chain: wallet.chain,
  });
}

/** Owner (issuer): revoke one credential. Takes effect for the very next action. */
export async function revokeCredential(wallet: WalletClient, statusRegistry: Address, credentialId: Hex, reason = "") {
  return wallet.writeContract({
    address: statusRegistry,
    abi: credentialStatusRegistryAbi,
    functionName: "revoke",
    args: [credentialId, reasonToBytes32(reason)],
    account: account(wallet),
    chain: wallet.chain,
  });
}

/** Owner: invalidate every credential of an agent at once. */
export async function revokeAllCredentials(wallet: WalletClient, statusRegistry: Address, agentId: bigint) {
  return wallet.writeContract({
    address: statusRegistry,
    abi: credentialStatusRegistryAbi,
    functionName: "revokeAll",
    args: [agentId],
    account: account(wallet),
    chain: wallet.chain,
  });
}

export function reasonToBytes32(reason: string): Hex {
  const hex = stringToHex(reason);
  if ((hex.length - 2) / 2 > 32) throw new Error("reason longer than 32 bytes");
  return stringToHex(reason, { size: 32 });
}

export async function credentialStatus(client: PublicClient, statusRegistry: Address, credentialId: Hex) {
  const [status, assurance, cred] = await Promise.all([
    client.readContract({ address: statusRegistry, abi: credentialStatusRegistryAbi, functionName: "statusOf", args: [credentialId] }),
    client.readContract({
      address: statusRegistry,
      abi: credentialStatusRegistryAbi,
      functionName: "ownerAssuranceOf",
      args: [credentialId],
    }),
    client.readContract({ address: statusRegistry, abi: credentialStatusRegistryAbi, functionName: "getCredential", args: [credentialId] }),
  ]);
  return {
    status: STATUSES[status] as CredentialStatus,
    ownerAssurance: OWNER_ASSURANCE[assurance] as OwnerAssurance,
    issuer: cred.issuer,
    agentId: cred.agentId,
    disclosureRoot: cred.disclosureRoot,
    vleiSaidHash: cred.vleiSaidHash,
  };
}

// ------------------------------------------------------------------ actions

export interface ActionIntent {
  credentialId: Hex;
  scope: Hex;
  asset: Address;
  amount: bigint;
  relyingParty: Address;
  nonce: bigint;
  deadline: bigint;
}

export const ACTION_INTENT_TYPES = {
  ActionIntent: [
    { name: "credentialId", type: "bytes32" },
    { name: "scope", type: "bytes32" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relyingParty", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function gateDomain(chainId: number, gate: Address) {
  return { name: "AgentPassportGate", version: "1", chainId, verifyingContract: gate } as const;
}

/** Random 256-bit nonce: the gate uses unordered nonces, so agents can run actions in parallel. */
export function randomNonce(): bigint {
  return hexToBigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
}

export function buildIntent(opts: {
  credentialId: Hex;
  scope: string;
  asset: Address;
  amount: bigint;
  relyingParty: Address;
  ttlSeconds?: number;
  now?: bigint;
}): ActionIntent {
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  return {
    credentialId: opts.credentialId,
    scope: scopeHash(opts.scope),
    asset: opts.asset,
    amount: opts.amount,
    relyingParty: opts.relyingParty,
    nonce: randomNonce(),
    deadline: now + BigInt(opts.ttlSeconds ?? 120),
  };
}

/** Agent: sign one action (the key binding PassportGate checks against the ERC-8004 agentWallet). */
export async function signIntent(agent: LocalAccount, chainId: number, gate: Address, intent: ActionIntent): Promise<Hex> {
  return agent.signTypedData({
    domain: gateDomain(chainId, gate),
    types: ACTION_INTENT_TYPES,
    primaryType: "ActionIntent",
    message: intent,
  });
}

/** Anyone: the gate's verdict for an action, without sending a transaction. */
export async function checkAuthorization(
  client: PublicClient,
  gate: Address,
  q: { agentId: bigint; scope: string; asset: Address; amount: bigint; relyingParty: Address; presentation: GatePresentation },
): Promise<{ authorized: boolean; reason: Reason }> {
  const r = await client.readContract({
    address: gate,
    abi: passportGateAbi,
    functionName: "check",
    args: [q.agentId, scopeHash(q.scope), q.asset, q.amount, q.relyingParty, q.presentation],
  });
  const reason = REASONS[r];
  return { authorized: reason === "Ok", reason };
}
