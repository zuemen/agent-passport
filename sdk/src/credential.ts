import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import {
  bytesToHex,
  hashTypedData,
  stringToHex,
  keccak256,
  type Address,
  type Hex,
  type LocalAccount,
  type WalletClient,
} from "viem";
import {
  ALLOWED,
  KEY_SCOPE,
  dailyLimitKey,
  maxPerTxKey,
  payeeKey,
  scopeHash,
  textKey,
  uint256ToBytes32,
} from "./claims.js";

export const LEAF_TYPES = ["bytes32", "bytes32", "bytes32"] as const;

export interface AssetLimit {
  asset: Address;
  /** Largest single action, in the asset's base units. */
  maxPerTx: bigint;
  /** Cumulative cap per UTC day, in base units. */
  dailyLimit: bigint;
  symbol?: string;
}

export interface AuthorizationInput {
  chainId: number;
  identityRegistry: Address;
  statusRegistry: Address;
  agentId: bigint;
  issuer: Address;
  scopes: string[];
  limits: AssetLimit[];
  /** Relying parties (contracts calling PassportGate) the agent may transact with. */
  payees: Address[];
  validFrom: bigint;
  validUntil: bigint;
  /** Private free-text claims, e.g. { purpose: "rebalance treasury", ownerName: "Example Treasury Ltd" }. */
  text?: Record<string, string>;
}

/** One committed claim. `name` is how SDK users select it; `display` is its human-readable value. */
export interface Claim {
  name: string;
  salt: Hex;
  key: Hex;
  value: Hex;
  display: string;
}

export type AgentAuthorization = {
  agentId: bigint;
  identityRegistry: Address;
  issuer: Address;
  disclosureRoot: Hex;
  validFrom: bigint;
  validUntil: bigint;
};

/** The W3C VC the owner signs. It carries only the Merkle root; claim values travel as disclosures. */
export interface AgentPassportVC {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: {
    agentRegistry: string;
    agentId: string;
    disclosureRoot: Hex;
    disclosureAlgorithm: "keccak256-salted-leaf/sorted-pair-merkle";
    claimCount: number;
  };
  credentialStatus: { type: "AgentPassportOnchainStatus"; statusRegistry: string };
  proof: {
    type: "EthereumEip712Signature2021";
    created: string;
    proofPurpose: "assertionMethod";
    verificationMethod: string;
    proofValue: Hex;
    eip712: { domain: Eip712Domain; primaryType: "AgentAuthorization"; types: typeof AUTHORIZATION_TYPES };
  };
}

/** What the agent (holder) keeps: the signed VC plus every claim with its salt. */
export interface HeldCredential {
  vc: AgentPassportVC;
  credentialId: Hex;
  authorization: AgentAuthorization;
  claims: Claim[];
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export const AUTHORIZATION_TYPES = {
  AgentAuthorization: [
    { name: "agentId", type: "uint256" },
    { name: "identityRegistry", type: "address" },
    { name: "issuer", type: "address" },
    { name: "disclosureRoot", type: "bytes32" },
    { name: "validFrom", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export function credentialDomain(chainId: number, statusRegistry: Address): Eip712Domain {
  return { name: "AgentPassportCredential", version: "1", chainId, verifyingContract: statusRegistry };
}

export function randomSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Expand the human-readable authorization into individually salted claims. */
export function buildClaims(input: AuthorizationInput, salt: () => Hex = randomSalt): Claim[] {
  const claims: Claim[] = [];
  for (const s of input.scopes) {
    claims.push({ name: `scope:${s}`, salt: salt(), key: KEY_SCOPE, value: scopeHash(s), display: s });
  }
  for (const l of input.limits) {
    const a = l.asset.toLowerCase();
    claims.push({
      name: `maxPerTx:${a}`,
      salt: salt(),
      key: maxPerTxKey(l.asset),
      value: uint256ToBytes32(l.maxPerTx),
      display: l.maxPerTx.toString(),
    });
    claims.push({
      name: `dailyLimit:${a}`,
      salt: salt(),
      key: dailyLimitKey(l.asset),
      value: uint256ToBytes32(l.dailyLimit),
      display: l.dailyLimit.toString(),
    });
  }
  for (const p of input.payees) {
    claims.push({ name: `payee:${p.toLowerCase()}`, salt: salt(), key: payeeKey(p), value: ALLOWED, display: "allowed" });
  }
  for (const [name, text] of Object.entries(input.text ?? {})) {
    claims.push({ name: `text:${name}`, salt: salt(), key: textKey(name), value: keccak256(stringToHex(text)), display: text });
  }
  const names = new Set(claims.map((c) => c.name));
  if (names.size !== claims.length) throw new Error("duplicate claim (repeated scope, asset or payee)");
  return claims;
}

export function claimTree(claims: Claim[]) {
  return StandardMerkleTree.of(
    claims.map((c) => [c.salt, c.key, c.value]),
    [...LEAF_TYPES],
  );
}

export function credentialIdOf(auth: AgentAuthorization, domain: Eip712Domain): Hex {
  return hashTypedData({ domain, types: AUTHORIZATION_TYPES, primaryType: "AgentAuthorization", message: auth });
}

/** An EOA (local account or wallet client), or any typed-data signer such as `passkeyTypedDataSigner`. */
type Signer = LocalAccount | WalletClient | { address: Address; type: "local"; signTypedData: (args: never) => Promise<Hex> };

async function signTyped(signer: Signer, args: Parameters<typeof hashTypedData>[0]): Promise<Hex> {
  if ("type" in signer && signer.type === "local") return (signer as { signTypedData: (a: never) => Promise<Hex> }).signTypedData(args as never);
  const wallet = signer as WalletClient;
  if (!wallet.account) throw new Error("wallet client has no account");
  return wallet.signTypedData({ ...(args as object), account: wallet.account } as never);
}

/**
 * Issue a credential: build salted claims, commit to them with a Merkle root and sign the
 * authorization (EIP-712) as the agent's owner. Anchor it on-chain with `anchorCredential`.
 */
export async function issueCredential(
  input: AuthorizationInput,
  signer: Signer,
  opts: { salt?: () => Hex; now?: Date } = {},
): Promise<HeldCredential> {
  const claims = buildClaims(input, opts.salt);
  const tree = claimTree(claims);
  const authorization: AgentAuthorization = {
    agentId: input.agentId,
    identityRegistry: input.identityRegistry,
    issuer: input.issuer,
    disclosureRoot: tree.root as Hex,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
  };
  const domain = credentialDomain(input.chainId, input.statusRegistry);
  const credentialId = credentialIdOf(authorization, domain);
  const proofValue = await signTyped(signer, {
    domain,
    types: AUTHORIZATION_TYPES,
    primaryType: "AgentAuthorization",
    message: authorization,
  });

  const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();
  const issuerDid = `did:pkh:eip155:${input.chainId}:${input.issuer}`;
  const vc: AgentPassportVC = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: `urn:agent-passport:${credentialId}`,
    type: ["VerifiableCredential", "AgentAuthorizationCredential"],
    issuer: issuerDid,
    validFrom: iso(input.validFrom),
    validUntil: iso(input.validUntil),
    credentialSubject: {
      agentRegistry: `eip155:${input.chainId}:${input.identityRegistry}`,
      agentId: input.agentId.toString(),
      disclosureRoot: authorization.disclosureRoot,
      disclosureAlgorithm: "keccak256-salted-leaf/sorted-pair-merkle",
      claimCount: claims.length,
    },
    credentialStatus: {
      type: "AgentPassportOnchainStatus",
      statusRegistry: `eip155:${input.chainId}:${input.statusRegistry}`,
    },
    proof: {
      type: "EthereumEip712Signature2021",
      created: (opts.now ?? new Date()).toISOString(),
      proofPurpose: "assertionMethod",
      verificationMethod: `${issuerDid}#blockchainAccountId`,
      proofValue,
      eip712: { domain, primaryType: "AgentAuthorization", types: AUTHORIZATION_TYPES },
    },
  };
  return { vc, credentialId, authorization, claims };
}

/** Rebuild the authorization struct from a VC (for verifiers, who never see the full claim set). */
export function authorizationFromVC(vc: AgentPassportVC): AgentAuthorization {
  const issuer = vc.issuer.split(":").at(-1); // did:pkh:eip155:<chainId>:<address>
  const registry = vc.credentialSubject.agentRegistry.split(":").at(-1); // eip155:<chainId>:<address>
  return {
    agentId: BigInt(vc.credentialSubject.agentId),
    identityRegistry: registry as Address,
    issuer: issuer as Address,
    disclosureRoot: vc.credentialSubject.disclosureRoot,
    validFrom: BigInt(Date.parse(vc.validFrom) / 1000),
    validUntil: BigInt(Date.parse(vc.validUntil) / 1000),
  };
}
