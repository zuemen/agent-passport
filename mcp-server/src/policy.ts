import { readFileSync } from "node:fs";

/**
 * What this agent is willing to disclose, by claim name pattern ("scope:*", "text:purpose", …).
 * Anything not allowed is refused by present_passport, whoever asks.
 *
 * Default: only the four claim kinds a relying party needs to authorize an action. Free-text claims
 * (owner name, purpose, internal references) never leave the agent unless the operator opts in.
 */
export interface DisclosurePolicy {
  allow: string[];
}

export const DEFAULT_POLICY: DisclosurePolicy = { allow: ["scope:*", "maxPerTx:*", "dailyLimit:*", "payee:*"] };

export function isDisclosable(policy: DisclosurePolicy, claimName: string): boolean {
  return policy.allow.some((p) => (p.endsWith("*") ? claimName.startsWith(p.slice(0, -1)) : claimName === p));
}

/** PASSPORT_DISCLOSURE_POLICY = path to a JSON file { "allow": [...] }. */
export function loadPolicy(path?: string): DisclosurePolicy {
  if (!path) return DEFAULT_POLICY;
  const p = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(p.allow) || !p.allow.every((x: unknown) => typeof x === "string")) {
    throw new Error("disclosure policy must be { \"allow\": string[] }");
  }
  return { allow: p.allow };
}
