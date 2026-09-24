import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, monadTestnet } from "@agent-passport/sdk";
import { createPassportServer, type PassportServerConfig } from "./server.js";
import { CredentialStore } from "./store.js";
import { loadPolicy } from "./policy.js";

const env = process.env;
const rpcUrl = env.MONAD_RPC_URL;
// PASSPORT_DEPLOYMENT: another deployment record (contracts/deployments/<chainId>.json), such as the local chain
// that `npm run local -w demo` starts; MONAD_RPC_URL then points at that chain. Default: Monad testnet.
const deployment: typeof MONAD_TESTNET & { chainId?: number } = env.PASSPORT_DEPLOYMENT
  ? JSON.parse(readFileSync(env.PASSPORT_DEPLOYMENT, "utf8"))
  : MONAD_TESTNET;
const chainId = deployment.chainId ?? monadTestnet.id;
const onTestnet = chainId === monadTestnet.id;
if (!onTestnet && !rpcUrl) throw new Error(`PASSPORT_DEPLOYMENT is chain ${chainId}: set MONAD_RPC_URL to its RPC`);
const chain = onTestnet
  ? monadTestnet
  : defineChain({
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl!] } },
    });
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export function config(agentMode: boolean): PassportServerConfig {
  const store = agentMode && env.PASSPORT_CREDENTIALS ? CredentialStore.fromDirectory(env.PASSPORT_CREDENTIALS) : undefined;
  const agentKey = env.PASSPORT_AGENT_KEY as Hex | undefined;
  return {
    client: client as never,
    gate: (env.PASSPORT_GATE ?? deployment.passportGate) as Address,
    statusRegistry: (env.PASSPORT_STATUS_REGISTRY ?? deployment.credentialStatusRegistry) as Address,
    defaults: {
      asset: (env.PASSPORT_DEFAULT_ASSET ?? deployment.demoUsd) as Address,
      relyingParty: deployment.passportDex,
      relyingParties: { "dex.swap": deployment.passportDex, "commerce.pay": deployment.passportMerchant },
    },
    store,
    policy: loadPolicy(env.PASSPORT_DISCLOSURE_POLICY),
    actions:
      store && agentKey
        ? {
            client: client as never,
            chain,
            rpcUrl,
            gate: (env.PASSPORT_GATE ?? deployment.passportGate) as Address,
            identityRegistry: (env.PASSPORT_IDENTITY_REGISTRY ?? deployment.identityRegistry) as Address,
            agent: privateKeyToAccount(agentKey),
            explorer: onTestnet ? "https://testnet.monadscan.com" : undefined,
          }
        : undefined,
  };
}

/** Host / Origin / bearer checks for the HTTP transport. Returns an error message, or undefined if allowed. */
export function checkRequest(
  req: Pick<IncomingMessage, "headers">,
  opts: { allowedHosts: string[]; allowedOrigins: string[]; token?: string },
): { status: number; message: string } | undefined {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!opts.allowedHosts.includes(host)) return { status: 403, message: `host "${host}" not allowed` };
  const origin = req.headers.origin;
  if (origin && !opts.allowedOrigins.includes(origin)) return { status: 403, message: `origin "${origin}" not allowed` };
  if (opts.token) {
    const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(opts.token);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, message: "missing or invalid bearer token" };
  }
  return undefined;
}

export function startHttp(port: number) {
  const bindHost = env.PASSPORT_HTTP_HOST ?? "127.0.0.1";
  const token = env.PASSPORT_HTTP_TOKEN || undefined;
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]", ...list(env.PASSPORT_ALLOWED_HOSTS)];
  const allowedOrigins = list(env.PASSPORT_ALLOWED_ORIGINS);
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const deny = (res: ServerResponse, status: number, message: string) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));

  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) return void res.writeHead(404).end();
    const bad = checkRequest(req, { allowedHosts, allowedOrigins, token });
    if (bad) return deny(res, bad.status, bad.message);

    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (sid && !transport) return deny(res, 404, "unknown session");
    if (!transport) {
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, t),
        onsessionclosed: (id) => void sessions.delete(id),
      });
      t.onclose = () => void (t.sessionId && sessions.delete(t.sessionId));
      // Agent-side tools only behind a token; otherwise verifier-only.
      await createPassportServer(config(Boolean(token))).connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res);
  });
  server.listen(port, bindHost, () =>
    console.error(`agent-passport MCP on http://${bindHost}:${port}/mcp (${token ? "agent mode, bearer auth" : "verifier-only"})`),
  );
  return server;
}

