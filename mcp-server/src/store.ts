import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deserializeCredential, type HeldCredential } from "@agent-passport/sdk";

/**
 * The agent's credential wallet: held credentials (with their salts) as JSON files written by
 * `serializeCredential`. Only the agent side of the MCP server needs this; verifiers don't.
 */
export class CredentialStore {
  private readonly byAgent = new Map<string, HeldCredential[]>();

  constructor(credentials: HeldCredential[] = []) {
    for (const c of credentials) this.add(c);
  }

  static fromDirectory(dir: string): CredentialStore {
    const store = new CredentialStore();
    if (!existsSync(dir)) return store;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      store.add(deserializeCredential(readFileSync(join(dir, f), "utf8")));
    }
    return store;
  }

  add(held: HeldCredential) {
    const k = held.authorization.agentId.toString();
    this.byAgent.set(k, [...(this.byAgent.get(k) ?? []), held]);
  }

  /** Newest credential for the agent (by validFrom), or a specific one by id. */
  get(agentId: bigint | string, credentialId?: string): HeldCredential {
    const list = this.byAgent.get(agentId.toString()) ?? [];
    const held = credentialId
      ? list.find((c) => c.credentialId.toLowerCase() === credentialId.toLowerCase())
      : [...list].sort((a, b) => Number(b.authorization.validFrom - a.authorization.validFrom))[0];
    if (!held) throw new Error(`no credential held for agent ${agentId}${credentialId ? ` (${credentialId})` : ""}`);
    return held;
  }

  agents(): string[] {
    return [...this.byAgent.keys()];
  }
}
