import { createServer, type IncomingMessage } from "node:http";
import { toHex, type Hex } from "viem";
import { type WebAuthnAssertion } from "@agent-passport/sdk";
import { deployment } from "./env.js";
import { Scenario } from "./scenario.js";
import { PasskeyOwnerFlow } from "./passkeyOwner.js";
import type { StepLog } from "./types.js";

/**
 * npm run api — local "live mode" backend for the demo app. It holds the demo owner / agent /
 * vLEI-verifier test keys (from .env) and sends real Monad testnet transactions when the app asks.
 * Testnet only; bind to localhost only.
 */
const PORT = Number(process.env.DEMO_API_PORT ?? 18790);
let scenario = new Scenario();
try {
  scenario.loadCredential(); // resume the last issued mandate, if any
} catch {
  /* no mandate issued yet */
}
let busy = false;

const steps: Record<string, (s: Scenario) => Promise<unknown>> = {
  setup: (s) => s.ensureAgent(),
  issue: (s) => s.issue(),
  "swap-ok": (s) => s.swap("swap-ok", "Agent swaps 80 apUSD within its limit", 80),
  "swap-over": (s) => s.swap("swap-over", "Agent tries 150 apUSD — over its per-transaction limit", 150, { expect: "rejected" }),
  "swap-injected": (s) =>
    s.swap("swap-injected", "Prompt-injected agent routes 50 apUSD through a look-alike DEX", 50, {
      dex: deployment.lookalikeDex,
      expect: "rejected",
    }),
  "pay-unverified": (s) => s.pay("pay-unverified", "Agent pays a merchant that requires a vLEI-verified owner", 5, "rejected"),
  vlei: (s) => s.recordVlei(),
  "pay-verified": (s) => s.pay("pay-verified", "Same payment after the owner's vLEI is verified", 5, "success"),
  revoke: (s) => s.revoke(),
  "swap-after-revoke": (s) => s.swap("swap-after-revoke", "Agent swaps 10 apUSD after revocation", 10, { expect: "rejected" }),
};

// ------------------------------------------------------------------ passkey owner (browser passkey)
// The flow runs here; whenever the owner must approve, it publishes a challenge that the app signs
// with the user's real passkey (navigator.credentials.get) and posts back.
let pk: { flow: PasskeyOwnerFlow; qx: Hex; qy: Hex } | undefined;
let pending: { challenge: Hex; purpose: string; resolve: (a: WebAuthnAssertion) => void; reject: (e: Error) => void } | undefined;
let job: { action: string; status: "running" | "done" | "error"; error?: string } | undefined;

const remoteSign = (challenge: Uint8Array, purpose: string) =>
  new Promise<WebAuthnAssertion>((resolve, reject) => {
    pending = { challenge: toHex(challenge), purpose, resolve, reject };
    setTimeout(() => {
      if (pending?.resolve === resolve) {
        pending = undefined;
        reject(new Error("passkey approval timed out"));
      }
    }, 180_000);
  });

const pkActions: Record<string, (f: PasskeyOwnerFlow) => Promise<unknown>> = {
  setup: (f) => f.setup(),
  swap: (f) => f.swap("Agent swaps 10 apUSD from the passkey owner's funds", 10_000_000n),
  revoke: (f) => f.revoke(),
  "swap-after-revoke": (f) => f.swap("Agent swaps 10 apUSD after the passkey revocation", 10_000_000n),
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const b64 = (s: unknown) => new Uint8Array(Buffer.from(String(s), "base64url"));

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "content-type": "application/json",
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/state") {
    return void res.writeHead(200, cors).end(
      JSON.stringify({
        live: true,
        agentId: scenario.agentId?.toString(),
        credentialId: scenario.held?.credentialId,
        steps: [...scenario.setup, ...scenario.steps],
        report: scenario.held && scenario.agentId !== undefined ? scenario.report(new Date()) : undefined,
      }),
    );
  }

  if (url.pathname.startsWith("/api/passkey/")) {
    const send = (code: number, body: unknown) => void res.writeHead(code, cors).end(JSON.stringify(body));
    try {
      if (req.method === "GET" && url.pathname === "/api/passkey/status") {
        return send(200, {
          job,
          pending: pending ? { challenge: pending.challenge, purpose: pending.purpose } : null,
          account: pk?.flow.account,
          agentId: pk?.flow.agentId?.toString(),
          credentialId: pk?.flow.held?.credentialId,
          steps: pk?.flow.steps ?? [],
        });
      }
      if (req.method === "POST" && url.pathname === "/api/passkey/start") {
        const body = await readJson(req);
        const action = String(body.action);
        if (!pkActions[action]) return send(400, { error: "unknown action" });
        if (job?.status === "running" || busy) return send(409, { error: "busy" });
        const qx = body.qx as Hex | undefined;
        const qy = body.qy as Hex | undefined;
        if (qx && qy && (!pk || pk.qx !== qx || pk.qy !== qy)) pk = { flow: new PasskeyOwnerFlow(qx, qy, remoteSign), qx, qy };
        if (!pk) return send(400, { error: "create a passkey first" });
        const flow = pk.flow;
        job = { action, status: "running" };
        pkActions[action](flow).then(
          () => (job = { action, status: "done" }),
          (e: Error) => (job = { action, status: "error", error: e.message }),
        );
        return send(202, { started: action });
      }
      if (req.method === "POST" && url.pathname === "/api/passkey/assertion") {
        if (!pending) return send(409, { error: "nothing to approve" });
        const body = await readJson(req);
        const p = pending;
        pending = undefined;
        p.resolve({ authenticatorData: b64(body.authenticatorData), clientDataJSON: b64(body.clientDataJSON), signature: b64(body.signature) });
        return send(200, { ok: true });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  }

  const m = url.pathname.match(/^\/api\/step\/([a-z-]+)$/);
  if (req.method === "POST" && m && steps[m[1]]) {
    if (busy) return void res.writeHead(409, cors).end(JSON.stringify({ error: "another step is running" }));
    busy = true;
    const before = scenario.setup.length + scenario.steps.length;
    try {
      if (m[1] === "setup") scenario = new Scenario();
      if (m[1] !== "setup" && m[1] !== "issue" && !scenario.held) {
        await scenario.ensureAgent();
        scenario.loadCredential();
      }
      await steps[m[1]](scenario);
      const all: StepLog[] = [...scenario.setup, ...scenario.steps];
      res.writeHead(200, cors).end(JSON.stringify({ steps: all.slice(before), report: scenario.held ? scenario.report(new Date()) : undefined }));
    } catch (e) {
      res.writeHead(500, cors).end(JSON.stringify({ error: (e as Error).message }));
    } finally {
      busy = false;
    }
    return;
  }
  res.writeHead(404, cors).end(JSON.stringify({ error: "not found" }));
}).listen(PORT, "127.0.0.1", () => console.log(`demo live API on http://127.0.0.1:${PORT}`));
