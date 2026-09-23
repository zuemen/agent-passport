import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { isAddressEqual, keccak256, stringToHex, verifyTypedData, type Address, type PublicClient } from "viem";
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
import { AUTHORIZATION_TYPES, LEAF_TYPES, authorizationFromVC, credentialIdOf } from "./credential.js";
import { credentialStatus, type CredentialStatus, type OwnerAssurance } from "./chain.js";
import type { Disclosure, Presentation } from "./presentation.js";

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  /** Only the disclosed claims, by name. */
  revealed: Record<string, string>;
  issuer: Address;
  agentId: bigint;
  onchain?: { status: CredentialStatus; ownerAssurance: OwnerAssurance };
}

/** Recompute what a disclosure's key/value must be from its name and display value. */
function expectedKeyValue(d: Disclosure) {
  const [kind, arg] = [d.name.slice(0, d.name.indexOf(":")), d.name.slice(d.name.indexOf(":") + 1)];
  switch (kind) {
    case "scope":
      return { key: KEY_SCOPE, value: scopeHash(arg) };
    case "maxPerTx":
      return { key: maxPerTxKey(arg as Address), value: uint256ToBytes32(BigInt(d.display)) };
    case "dailyLimit":
      return { key: dailyLimitKey(arg as Address), value: uint256ToBytes32(BigInt(d.display)) };
    case "payee":
      return { key: payeeKey(arg as Address), value: ALLOWED };
    case "text":
      return { key: textKey(arg), value: keccak256(stringToHex(d.display)) };
    default:
      return undefined;
  }
}

/**
 * Verify a presentation: issuer signature, that every disclosed claim is committed to by the signed
 * root and says what its name/display claim, and — if a client is given — that the credential is
 * anchored with the same root and issuer and is currently Active on-chain.
 */
export async function verifyPresentation(
  p: Presentation,
  opts: { client?: PublicClient; statusRegistry?: Address } = {},
): Promise<VerificationResult> {
  const errors: string[] = [];
  const auth = authorizationFromVC(p.vc);
  const domain = p.vc.proof.eip712.domain;

  const id = credentialIdOf(auth, domain);
  if (id !== p.credentialId || p.vc.id !== `urn:agent-passport:${id}`) errors.push("credential id mismatch");

  const sigOk = await verifyTypedData({
    address: auth.issuer,
    domain,
    types: AUTHORIZATION_TYPES,
    primaryType: "AgentAuthorization",
    message: auth,
    signature: p.vc.proof.proofValue,
  });
  if (!sigOk) errors.push("issuer signature invalid");

  const revealed: Record<string, string> = {};
  for (const d of p.disclosures) {
    const inTree = StandardMerkleTree.verify(auth.disclosureRoot, [...LEAF_TYPES], [d.salt, d.key, d.value], d.proof);
    if (!inTree) {
      errors.push(`disclosure "${d.name}" is not part of this credential`);
      continue;
    }
    const exp = expectedKeyValue(d);
    if (!exp || exp.key !== d.key || exp.value !== d.value) {
      errors.push(`disclosure "${d.name}" does not match its committed value`);
      continue;
    }
    revealed[d.name] = d.display;
  }

  let onchain: VerificationResult["onchain"];
  if (opts.client) {
    const registry = opts.statusRegistry ?? domain.verifyingContract;
    const s = await credentialStatus(opts.client, registry, p.credentialId);
    onchain = { status: s.status, ownerAssurance: s.ownerAssurance };
    if (s.status !== "Active") errors.push(`on-chain status is ${s.status}`);
    if (s.status !== "Unknown") {
      if (s.disclosureRoot !== auth.disclosureRoot) errors.push("on-chain root differs from the signed root");
      if (!isAddressEqual(s.issuer, auth.issuer)) errors.push("on-chain issuer differs from the signer");
      if (s.agentId !== auth.agentId) errors.push("on-chain agent differs");
    }
  }

  return { valid: errors.length === 0, errors, revealed, issuer: auth.issuer, agentId: auth.agentId, onchain };
}
