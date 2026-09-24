#!/usr/bin/env node
/**
 * npm run demo-run -w mcp-server — a scripted MCP client drives the Agent Passport MCP server (agent mode)
 * through the prompt-injection story on Monad testnet, and records every call and result.
 *
 * Spends testnet MON from the agent wallet: one swap within the mandate, and one transaction to a
 * look-alike DEX that the gate reverts on-chain. The agent key is read from ../.env and handed only to the
 * server process; it is never printed or written.
 *
 * --dry stops after the read-only checks, before anything is sent.
 *
 * Output: demo/public/runs/mcp-latest.json. With --live <file>, each step is also appended to <file> as it
 * happens (for a live log view).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MONAD_TESTNET as C } from "@agent-passport/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const liveArg = process.argv.indexOf("--live");
const liveFile = liveArg > 0 ? process.argv[liveArg + 1] : undefined;

function readEnv() {
  const file = join(repoRoot, ".env");
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const dotenv = readEnv();
const agentKey = process.env.DEMO_AGENT_KEY || dotenv.DEMO_AGENT_KEY;
if (!agentKey) throw new Error("DEMO_AGENT_KEY is not set (see .env.example)");

const AGENT_ID = "1";
const USD = (n) => String(BigInt(Math.round(n * 1e6)));
const run = { version: 1, startedAt: new Date().toISOString(), chainId: 10143, client: "scripted MCP client (no LLM)", agentId: AGENT_ID, steps: [] };

function record(step) {
  run.steps.push({ at: new Date().toISOString(), ...step });
  if (liveFile) writeFileSync(liveFile, JSON.stringify(run, null, 2));
  const r = step.result ?? {};
  const summary = step.error ?? r.reason ?? (r.availableClaims ? `${r.availableClaims.length} claims` : "ok");
  console.log(`${step.id.padEnd(18)} ${step.tool.padEnd(20)} ${summary}${r.txHash ? `  ${r.txHash}` : ""}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "mcp-server", "dist", "index.js")],
  env: {
    ...getDefaultEnvironment(),
    PASSPORT_CREDENTIALS: join(repoRoot, "mcp-server", "credentials"),
    PASSPORT_AGENT_KEY: agentKey,
    ...(dotenv.MONAD_TESTNET_RPC_URL ? { MONAD_RPC_URL: dotenv.MONAD_TESTNET_RPC_URL } : {}),
  },
  stderr: "ignore",
});
const client = new Client({ name: "agent-passport-demo-run", version: "0.1.0" });
await client.connect(transport);

async function call(id, title, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
  const text = res.content?.find((c) => c.type === "text")?.text;
  const step = { id, title, tool, args };
  if (res.isError) step.error = text;
  else step.result = res.structuredContent ?? (text ? JSON.parse(text) : {});
  record(step);
  return step;
}

try {
  const { tools } = await client.listTools();
  record({ id: "tools", title: "The agent's MCP server exposes its tools", tool: "tools/list", args: {}, result: { tools: tools.map((t) => t.name) } });

  const claims = await call("claims", "Which claims could the agent show?", "present_passport", { agentId: AGENT_ID, disclose: [] });

  const pre = await call("check", "May the agent swap 20 apUSD on the DEX? (read-only)", "check_authorization", {
    agentId: AGENT_ID, scope: "dex.swap", amount: USD(20), relyingParty: C.passportDex,
  });
  if (!pre.result?.authorized) throw new Error(`pre-check failed (${pre.result?.reason ?? pre.error}); nothing was sent`);
  if (process.argv.includes("--dry")) throw new Error("--dry: stopped before sending anything");

  await call("swap", "Swap 20 apUSD within the mandate", "execute_action", {
    agentId: AGENT_ID, scope: "dex.swap", amount: USD(20), relyingParty: C.passportDex,
  });
  await call("injected", "Injected instruction: route 50 apUSD to a look-alike DEX", "execute_action", {
    agentId: AGENT_ID, scope: "dex.swap", amount: USD(50), relyingParty: C.lookalikeDex,
  });
  await call("injected-forced", "Send it anyway (forceSubmit)", "execute_action", {
    agentId: AGENT_ID, scope: "dex.swap", amount: USD(50), relyingParty: C.lookalikeDex, forceSubmit: true,
  });

  const hiddenClaims = (claims.result?.availableClaims ?? []).filter((c) => !c.disclosable).map((c) => c.name);
  const hidden = hiddenClaims.find((n) => n === "text:ownerName") ?? hiddenClaims[0];
  if (hidden) {
    await call("disclose-hidden", `A counterparty asks for a hidden claim (${hidden})`, "present_passport", {
      agentId: AGENT_ID, disclose: [hidden],
    });
  }
} finally {
  run.finishedAt = new Date().toISOString();
  run.done = true;
  if (liveFile) writeFileSync(liveFile, JSON.stringify(run, null, 2));
  writeFileSync(join(repoRoot, "demo", "public", "runs", "mcp-latest.json"), JSON.stringify(run, null, 2) + "\n");
  await client.close();
}
