import type { HeldCredential } from "./credential.js";

/** JSON (de)serialisation that keeps bigints, for storing a held credential in a wallet or agent. */
export function serializeCredential(held: HeldCredential): string {
  return JSON.stringify(held, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function deserializeCredential(json: string): HeldCredential {
  return JSON.parse(json, (_k, v) => (v && typeof v === "object" && "$bigint" in v ? BigInt(v.$bigint) : v));
}
