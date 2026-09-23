#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPublicClient, http, type Address } from "viem";
import { MONAD_TESTNET, monadTestnet } from "@agent-passport/sdk";
import { createPassportServer } from "./server.js";
import { CredentialStore } from "./store.js";

/**
 * agent-passport-mcp [--http <port>]
 *
 * Env:
 *   MONAD_RPC_URL        default https://testnet-rpc.monad.xyz
 *   PASSPORT_CREDENTIALS directory of held credentials (agent mode); omit for verifier-only mode
 *   PASSPORT_GATE, PASSPORT_STATUS_REGISTRY, PASSPORT_DEFAULT_ASSET, PASSPORT_DEFAULT_RELYING_PARTY
 *                        override the Monad testnet deployment
 */
const env = process.env;
const client = createPublicClient({ chain: monadTestnet, transport: http(env.MONAD_RPC_URL) });

const config = () => ({
  client: client as never,
  gate: (env.PASSPORT_GATE ?? MONAD_TESTNET.passportGate) as Address,
  statusRegistry: (env.PASSPORT_STATUS_REGISTRY ?? MONAD_TESTNET.credentialStatusRegistry) as Address,
  defaults: {
    asset: (env.PASSPORT_DEFAULT_ASSET ?? MONAD_TESTNET.demoUsd) as Address,
    relyingParty: (env.PASSPORT_DEFAULT_RELYING_PARTY ?? MONAD_TESTNET.passportDex) as Address,
  },
  store: env.PASSPORT_CREDENTIALS ? CredentialStore.fromDirectory(env.PASSPORT_CREDENTIALS) : undefined,
});

const httpIndex = process.argv.indexOf("--http");
if (httpIndex === -1) {
  await createPassportServer(config()).connect(new StdioServerTransport());
} else {
  // Streamable HTTP, stateful sessions. This is the endpoint advertised in the agent's ERC-8004
  // registration file so other agents can discover and call it.
  const port = Number(process.argv[httpIndex + 1] ?? 8788);
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, transport!),
      });
      transport.onclose = () => transport!.sessionId && sessions.delete(transport!.sessionId);
      await createPassportServer(config()).connect(transport);
    }
    await transport.handleRequest(req, res);
  }).listen(port, () => console.error(`agent-passport MCP on http://localhost:${port}/mcp`));
}
