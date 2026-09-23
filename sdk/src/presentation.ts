import type { Address, Hex } from "viem";
import { claimTree, type AgentPassportVC, type Claim, type HeldCredential } from "./credential.js";

export interface Disclosure extends Claim {
  proof: Hex[];
}

/** Off-chain presentation: the signed VC plus only the selected claims, each with its Merkle proof. */
export interface Presentation {
  vc: AgentPassportVC;
  credentialId: Hex;
  disclosures: Disclosure[];
}

/** Presentation struct as PassportGate expects it on-chain. */
export interface GatePresentation {
  credentialId: Hex;
  scope: GateDisclosure;
  maxPerTx: GateDisclosure;
  dailyLimit: GateDisclosure;
  payee: GateDisclosure;
}

export interface GateDisclosure {
  salt: Hex;
  key: Hex;
  value: Hex;
  proof: Hex[];
}

function disclose(held: HeldCredential, name: string): Disclosure {
  const i = held.claims.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`credential has no claim "${name}"`);
  const tree = claimTree(held.claims);
  return { ...held.claims[i], proof: tree.getProof(i) as Hex[] };
}

/**
 * Reveal exactly the named claims (e.g. ["scope:dex.swap", "text:purpose"]). Everything else stays
 * hidden behind its salt. Use `listClaims` to see what the credential holds.
 */
export function createPresentation(held: HeldCredential, names: string[]): Presentation {
  return { vc: held.vc, credentialId: held.credentialId, disclosures: names.map((n) => disclose(held, n)) };
}

export function listClaims(held: HeldCredential): { name: string; display: string }[] {
  return held.claims.map(({ name, display }) => ({ name, display }));
}

/** The four claims PassportGate needs for one action — and nothing else. */
export function gateClaimNames(opts: { scope: string; asset: Address; relyingParty: Address }): string[] {
  const a = opts.asset.toLowerCase();
  return [`scope:${opts.scope}`, `maxPerTx:${a}`, `dailyLimit:${a}`, `payee:${opts.relyingParty.toLowerCase()}`];
}

export function toGatePresentation(
  held: HeldCredential,
  opts: { scope: string; asset: Address; relyingParty: Address },
): GatePresentation {
  const [scope, maxPerTx, dailyLimit, payee] = gateClaimNames(opts).map((n) => {
    const d = disclose(held, n);
    return { salt: d.salt, key: d.key, value: d.value, proof: d.proof };
  });
  return { credentialId: held.credentialId, scope, maxPerTx, dailyLimit, payee };
}
