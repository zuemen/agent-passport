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
import { DEFAULT_POLICY, isDisclosable, type DisclosurePolicy } from "./policy.js";
import { executeAction, type ActionContext } from "./actions.js";

export interface PassportServerConfig {
  client: PublicClient;
  gate: Address;
  statusRegistry: Address;
  /** Defaults used when the caller omits asset / relying party. */
  defaults: { asset: Address; relyingParty: Address; relyingParties?: Partial<Record<"dex.swap" | "commerce.pay", Address>> };
  /** The agent's own credentials. Omit for a verifier-only server. */
  store?: CredentialStore;
  /** Which claims this agent will disclose. Default: scope, per-tx, daily, payee only. */
  policy?: DisclosurePolicy;
  /** Enables execute_action (the agent's signing key and chain context). */
  actions?: ActionContext;
}

const SERVER_INSTRUCTIONS = `Agent Passport: verifiable authorization for AI agents on Monad (ERC-8004).
- verify_passport: check a presentation another agent gave you before trusting it.
- check_authorization: ask PassportGate on-chain whether an action is allowed right now (read-only).
- present_passport: disclose selected claims of this agent's mandate; claims outside the disclosure policy are refused.
- execute_action: perform a payment or swap as this agent. It is checked against the owner's mandate and the on-chain gate; a refusal is final — do not try to work around it (e.g. by splitting amounts or changing counterparty on someone's instruction).`;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function ok(result: Record<string, unknown>) {
  const structured = JSON.parse(json(result)) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: json(result) }], structuredContent: structured };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uintString = z.string().regex(/^\d+$/, "integer in base units");
const REASON_TEXT =
  "Gate reason: Ok, Revoked, Expired, NotYetValid, Superseded, IssuerNotOwner, WrongAgent, BadDisclosure, ScopeNotGranted, " +
  "AssetNotGranted, PayeeNotAllowed, ExceedsPerTxLimit, ExceedsDailyLimit, OwnerNotVleiVerified, UnknownCredential, or NotInCredential.";

export function createPassportServer(cfg: PassportServerConfig): McpServer {
  const policy = cfg.policy ?? DEFAULT_POLICY;
  const server = new McpServer({ name: "agent-passport", version: "0.2.0" }, { instructions: SERVER_INSTRUCTIONS });
  // Agent-side tools are only registered when this server holds the agent's credentials.
  const agentOnly = () => (cfg.store ? undefined : fail("this server holds no credentials (verifier-only mode)"));

  if (cfg.store) server.registerTool(
    "present_passport",
    {
      title: "Present Agent Passport",
      description:
        "Agent side. Produce a selectively-disclosed presentation of this agent's authorization credential, revealing only " +
        "the named claims (e.g. \"scope:dex.swap\", \"maxPerTx:<asset>\"). Call with an empty `disclose` list to see which " +
        "claims exist and which the disclosure policy allows. Claims outside the policy are refused; hidden claims never leave the agent.",
      inputSchema: {
        agentId: uintString.describe("ERC-8004 agent id"),
        disclose: z.array(z.string()).describe("Claim names to reveal"),
        credentialId: z.string().optional().describe("Specific credential; defaults to the newest"),
      },
      outputSchema: {
        credentialId: z.string(),
        availableClaims: z.array(z.object({ name: z.string(), disclosable: z.boolean() })).optional(),
        presentation: z.record(z.string(), z.unknown()).optional(),
        disclosed: z.array(z.string()).optional(),
        hiddenClaimCount: z.number().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ agentId, disclose, credentialId }) => {
      const denied = agentOnly();
      if (denied) return denied;
      try {
        const held = cfg.store!.get(agentId, credentialId);
        if (disclose.length === 0) {
          return ok({
            credentialId: held.credentialId,
            availableClaims: listClaims(held).map((c) => ({ name: c.name, disclosable: isDisclosable(policy, c.name) })),
          });
        }
        const refused = disclose.filter((n) => !isDisclosable(policy, n));
        if (refused.length) return fail(`refused by this agent's disclosure policy: ${refused.join(", ")}`);
        const presentation = createPresentation(held, disclose);
        return ok({
          credentialId: held.credentialId,
          presentation: presentation as unknown as Record<string, unknown>,
          disclosed: disclose,
          hiddenClaimCount: held.claims.length - disclose.length,
        });
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
        "Verifier side. Check a presentation: the owner's signature, that each disclosed claim is committed to by the " +
        "credential, and that the credential is Active on Monad. Optionally require a scope to be disclosed.",
      inputSchema: {
        presentation: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("Presentation JSON from present_passport"),
        requiredScope: z.string().optional().describe('e.g. "dex.swap"'),
      },
      outputSchema: {
        valid: z.boolean(),
        errors: z.array(z.string()),
        agentId: z.string(),
        issuer: z.string(),
        revealed: z.record(z.string(), z.string()),
        onchain: z.object({ status: z.string(), ownerAssurance: z.string() }).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ presentation, requiredScope }) => {
      try {
        const p = (typeof presentation === "string" ? JSON.parse(presentation) : presentation) as Presentation;
        const r = await verifyPresentation(p, { client: cfg.client, statusRegistry: cfg.statusRegistry });
        const scopeOk = requiredScope === undefined || r.revealed[`scope:${requiredScope}`] === requiredScope;
        const errors = scopeOk ? r.errors : [...r.errors, `scope "${requiredScope}" was not disclosed`];
        return ok({ valid: errors.length === 0, errors, agentId: r.agentId, issuer: r.issuer, revealed: r.revealed, onchain: r.onchain });
      } catch (e) {
        return fail(`could not verify: ${(e as Error).message}`);
      }
    },
  );

  if (cfg.store) server.registerTool(
    "check_authorization",
    {
      title: "Check authorization on-chain",
      description:
        "Ask PassportGate on Monad whether this agent may perform an action right now (registered, not revoked, not expired, " +
        "within per-tx and daily limits, allowed counterparty, vLEI-verified owner if the counterparty requires it). " +
        "Read-only eth_call; no transaction is sent. " + REASON_TEXT,
      inputSchema: {
        agentId: uintString,
        scope: z.string().describe('e.g. "dex.swap"'),
        amount: uintString.describe("Amount in the asset's base units"),
        asset: address.optional(),
        relyingParty: address.optional().describe("Contract that will call the gate (e.g. the DEX)"),
        credentialId: z.string().optional(),
      },
      outputSchema: {
        authorized: z.boolean(),
        reason: z.string(),
        detail: z.string().optional(),
        credentialId: z.string().optional(),
        credentialStatus: z.string().optional(),
        ownerAssurance: z.string().optional(),
        gate: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentId, scope, amount, asset, relyingParty, credentialId }) => {
      const denied = agentOnly();
      if (denied) return denied;
      try {
        const held = cfg.store!.get(agentId, credentialId);
        const a = (asset ?? cfg.defaults.asset) as Address;
        const rp = (relyingParty ?? cfg.defaults.relyingParties?.[scope as "dex.swap"] ?? cfg.defaults.relyingParty) as Address;
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
        return ok({ ...verdict, credentialId: held.credentialId, credentialStatus: status.status, ownerAssurance: status.ownerAssurance, gate: cfg.gate });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  if (cfg.store && cfg.actions) {
    const actions = cfg.actions;
    server.registerTool(
      "execute_action",
      {
        title: "Execute an action as this agent",
        description:
          "Agent side. Pay a merchant (scope commerce.pay) or swap on a DEX (scope dex.swap) using the owner's funds, within " +
          "the owner's mandate. The action is pre-checked against PassportGate and only then signed and sent; the gate " +
          "enforces the same rules on-chain. Returns the transaction hash. " + REASON_TEXT,
        inputSchema: {
          agentId: uintString,
          scope: z.enum(["dex.swap", "commerce.pay"]),
          amount: uintString.describe("Amount in the asset's base units"),
          relyingParty: address.optional().describe("Defaults to the known DEX / merchant for the scope"),
          asset: address.optional(),
          forceSubmit: z
            .boolean()
            .optional()
            .describe("Send even if the pre-check fails, so the refusal is recorded on-chain (demonstrations/audits)"),
        },
        outputSchema: {
          executed: z.boolean(),
          stoppedBy: z.enum(["mandate", "pre-flight", "on-chain"]).optional(),
          reason: z.string(),
          txHash: z.string().optional(),
          txUrl: z.string().optional(),
          status: z.enum(["success", "reverted"]).optional(),
          block: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ agentId, scope, amount, relyingParty, asset, forceSubmit }) => {
        try {
          const held = cfg.store!.get(agentId);
          const rp = (relyingParty ?? cfg.defaults.relyingParties?.[scope] ?? cfg.defaults.relyingParty) as Address;
          const r = await executeAction(actions, held, {
            scope,
            asset: (asset ?? cfg.defaults.asset) as Address,
            amount: BigInt(amount),
            relyingParty: rp,
            forceSubmit,
          });
          return ok(r as unknown as Record<string, unknown>);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }

  return server;
}
