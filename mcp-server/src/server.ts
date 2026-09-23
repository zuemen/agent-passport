import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Address, PublicClient } from "viem";
import {
  checkAuthorization,
  createPresentation,
  credentialStatus,
  listClaims,
  toGatePresentation,
  verifyPresentation,
  type Presentation,
} from "@agent-passport/sdk";
import type { CredentialStore } from "./store.js";

export interface PassportServerConfig {
  client: PublicClient;
  gate: Address;
  statusRegistry: Address;
  /** Defaults used by check_authorization when the caller omits them. */
  defaults: { asset: Address; relyingParty: Address };
  /** The agent's own credentials. Omit for a verifier-only server. */
  store?: CredentialStore;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function ok(result: Record<string, unknown>) {
  const structured = JSON.parse(json(result)) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: json(result) }], structuredContent: structured };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export function createPassportServer(cfg: PassportServerConfig): McpServer {
  const server = new McpServer({ name: "agent-passport", version: "0.1.0" });

  server.registerTool(
    "present_passport",
    {
      title: "Present Agent Passport",
      description:
        "Agent side. Produce a selectively-disclosed presentation of this agent's authorization credential, " +
        "revealing only the named claims (e.g. \"scope:dex.swap\", \"maxPerTx:<asset>\", \"text:purpose\"). " +
        "Call with an empty `disclose` list to see which claim names exist. Hidden claims never leave the agent.",
      inputSchema: {
        agentId: z.string().describe("ERC-8004 agent id"),
        disclose: z.array(z.string()).describe("Claim names to reveal"),
        credentialId: z.string().optional().describe("Specific credential; defaults to the newest"),
      },
    },
    async ({ agentId, disclose, credentialId }) => {
      if (!cfg.store) return fail("this server holds no credentials (verifier-only mode)");
      try {
        const held = cfg.store.get(agentId, credentialId);
        if (disclose.length === 0) return ok({ credentialId: held.credentialId, availableClaims: listClaims(held).map((c) => c.name) });
        const presentation = createPresentation(held, disclose);
        return ok({ presentation, disclosed: disclose, hiddenClaimCount: held.claims.length - disclose.length });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "verify_passport",
    {
      title: "Verify Agent Passport",
      description:
        "Verifier side. Check a presentation: the owner's signature, that each disclosed claim is committed to by " +
        "the credential, and that the credential is Active on Monad. Optionally require a scope to be disclosed.",
      inputSchema: {
        presentation: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("Presentation JSON from present_passport"),
        requiredScope: z.string().optional().describe('e.g. "dex.swap"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ presentation, requiredScope }) => {
      try {
        const p = (typeof presentation === "string" ? JSON.parse(presentation) : presentation) as Presentation;
        const r = await verifyPresentation(p, { client: cfg.client, statusRegistry: cfg.statusRegistry });
        const scopeOk = requiredScope === undefined || r.revealed[`scope:${requiredScope}`] === requiredScope;
        const errors = scopeOk ? r.errors : [...r.errors, `scope "${requiredScope}" was not disclosed`];
        return ok({
          valid: errors.length === 0,
          errors,
          agentId: r.agentId,
          issuer: r.issuer,
          revealed: r.revealed,
          onchain: r.onchain,
        });
      } catch (e) {
        return fail(`could not verify: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "check_authorization",
    {
      title: "Check authorization on-chain",
      description:
        "Ask PassportGate on Monad whether the agent may perform an action right now (registered, not revoked, " +
        "not expired, within per-tx and daily limits, allowed counterparty, and vLEI owner if required). " +
        "Returns the gate's reason code. Read-only; no transaction is sent.",
      inputSchema: {
        agentId: z.string(),
        scope: z.string().describe('e.g. "dex.swap"'),
        amount: z.string().describe("Amount in the asset's base units (integer string)"),
        asset: address.optional(),
        relyingParty: address.optional().describe("Contract that will call the gate (e.g. the DEX)"),
        credentialId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId, scope, amount, asset, relyingParty, credentialId }) => {
      if (!cfg.store) return fail("this server holds no credentials (verifier-only mode)");
      try {
        const held = cfg.store.get(agentId, credentialId);
        const a = (asset ?? cfg.defaults.asset) as Address;
        const rp = (relyingParty ?? cfg.defaults.relyingParty) as Address;
        let presentation;
        try {
          presentation = toGatePresentation(held, { scope, asset: a, relyingParty: rp });
        } catch (e) {
          return ok({ authorized: false, reason: "NotInCredential", detail: (e as Error).message });
        }
        const verdict = await checkAuthorization(cfg.client, cfg.gate, {
          agentId: BigInt(agentId),
          scope,
          asset: a,
          amount: BigInt(amount),
          relyingParty: rp,
          presentation,
        });
        const status = await credentialStatus(cfg.client, cfg.statusRegistry, held.credentialId);
        return ok({
          ...verdict,
          credentialId: held.credentialId,
          credentialStatus: status.status,
          ownerAssurance: status.ownerAssurance,
          gate: cfg.gate,
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
