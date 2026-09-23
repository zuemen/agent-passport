#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPassportServer } from "./server.js";
import { config, startHttp } from "./http.js";

/**
 * agent-passport-mcp [--http <port>]
 *
 * stdio (default): a local MCP client (Claude Desktop, Claude Code, an agent framework) launches this
 * process; it runs in agent mode if PASSPORT_CREDENTIALS is set.
 *
 * --http: Streamable HTTP at /mcp. Security, per the MCP transport spec:
 *   - binds to 127.0.0.1 unless PASSPORT_HTTP_HOST is set;
 *   - rejects requests whose Host is not allowed (DNS rebinding) and whose Origin is not allowed;
 *   - agent-side tools (present/check/execute) are only served over HTTP when PASSPORT_HTTP_TOKEN is
 *     set, and then every request must carry `Authorization: Bearer <token>`. Without a token the
 *     HTTP server is verifier-only (verify_passport), which is safe to expose publicly.
 *
 * Env: MONAD_RPC_URL · PASSPORT_CREDENTIALS · PASSPORT_DISCLOSURE_POLICY · PASSPORT_AGENT_KEY (enables
 * execute_action) · PASSPORT_GATE · PASSPORT_STATUS_REGISTRY · PASSPORT_IDENTITY_REGISTRY ·
 * PASSPORT_DEFAULT_ASSET · PASSPORT_HTTP_HOST · PASSPORT_HTTP_TOKEN · PASSPORT_ALLOWED_HOSTS ·
 * PASSPORT_ALLOWED_ORIGINS (comma-separated)
 */
const httpIndex = process.argv.indexOf("--http");
if (httpIndex === -1) await createPassportServer(config(true)).connect(new StdioServerTransport());
else startHttp(Number(process.argv[httpIndex + 1] ?? 8788));
