import { createServer } from "node:http";
import { MONAD_TESTNET } from "@agent-passport/sdk";
import { Scenario } from "./scenario.js";
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
      dex: MONAD_TESTNET.lookalikeDex,
      expect: "rejected",
    }),
  "pay-unverified": (s) => s.pay("pay-unverified", "Agent pays a merchant that requires a vLEI-verified owner", 5, "rejected"),
  vlei: (s) => s.recordVlei(),
  "pay-verified": (s) => s.pay("pay-verified", "Same payment after the owner's vLEI is verified", 5, "success"),
  revoke: (s) => s.revoke(),
  "swap-after-revoke": (s) => s.swap("swap-after-revoke", "Agent swaps 10 apUSD after revocation", 10, { expect: "rejected" }),
};

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
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
