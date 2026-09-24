# @agent-passport/mcp-server

An MCP server that lets any AI agent use Agent Passport — present its authorization, verify another
agent's, and ask PassportGate on Monad for a verdict before acting.

| Tool | Mode | What it does |
|---|---|---|
| `present_passport(agentId, disclose[])` | agent | Selectively-disclosed presentation of the agent's credential. Empty `disclose` lists the claims and which the **disclosure policy** allows. Anything outside the policy is refused, whoever asks. |
| `verify_passport(presentation, requiredScope?)` | any | Owner signature, Merkle membership of each disclosed claim, on-chain status (Active / Revoked / Expired …) and vLEI owner assurance. |
| `check_authorization(agentId, scope, amount, asset?, relyingParty?)` | agent | Read-only `PassportGate.check` on Monad; returns the gate's reason code. |
| `execute_action(agentId, scope, amount, relyingParty?, asset?, forceSubmit?)` | agent + key | Swap (`dex.swap`) or pay (`commerce.pay`) as the agent, with the owner's funds. Refuses locally if the mandate does not cover it, pre-checks the gate, then signs and sends. `forceSubmit` sends anyway so the gate's refusal is recorded on-chain. |

Every tool declares an `outputSchema` (structured results) and annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`); the server sends `instructions` telling the model
that a refusal is final. Protocol version negotiated by the official TypeScript SDK (latest `2025-11-25`).

### Disclosure policy
Default: only `scope:*`, `maxPerTx:*`, `dailyLimit:*`, `payee:*` — what a relying party needs to
authorize an action. Free-text claims (owner name, purpose, internal references) never leave the agent
unless the operator widens the policy: `PASSPORT_DISCLOSURE_POLICY=policy.json` with `{ "allow": [...] }`.

### Transport security (Streamable HTTP)
- binds to `127.0.0.1` unless `PASSPORT_HTTP_HOST` is set;
- validates `Host` (DNS-rebinding protection; extend with `PASSPORT_ALLOWED_HOSTS`) and `Origin`
  (`PASSPORT_ALLOWED_ORIGINS`), answering 403 otherwise;
- without `PASSPORT_HTTP_TOKEN` the HTTP server is **verifier-only** (only `verify_passport`), safe to
  expose publicly; with a token, agent tools are served and every request needs `Authorization: Bearer`.
- stdio (a local client launching the process) runs in agent mode when `PASSPORT_CREDENTIALS` is set.

## Run
```bash
npm run build
# stdio (Claude Desktop / Claude Code / any MCP client)
PASSPORT_CREDENTIALS=./credentials node dist/index.js
# Streamable HTTP — the endpoint advertised in the agent's ERC-8004 registration file
node dist/index.js --http 8788            # verifier-only, safe to expose -> http://127.0.0.1:8788/mcp
PASSPORT_CREDENTIALS=./credentials PASSPORT_HTTP_TOKEN=… node dist/index.js --http 8788   # agent mode
```

Without `PASSPORT_CREDENTIALS` the server runs in verifier-only mode: only `verify_passport` is
registered. `execute_action` additionally needs `PASSPORT_AGENT_KEY` (must be the agent's ERC-8004
wallet). Credentials are files written with `serializeCredential` from the SDK.

| Env | Default |
|---|---|
| `MONAD_RPC_URL` | `https://testnet-rpc.monad.xyz` |
| `PASSPORT_GATE`, `PASSPORT_STATUS_REGISTRY` | Monad testnet deployment |
| `PASSPORT_DEFAULT_ASSET` | demo apUSD (the relying party defaults per scope: PassportDex for `dex.swap`, PassportMerchant for `commerce.pay`) |

Example client config:
```json
{ "mcpServers": { "agent-passport": { "command": "node", "args": ["<repo>/mcp-server/dist/index.js"],
  "env": { "PASSPORT_CREDENTIALS": "<repo>/mcp-server/credentials" } } } }
```

## Discovery
Put the HTTP endpoint in the agent's ERC-8004 registration file (`buildRegistrationFile` + `toDataUri`
in the SDK, then `setAgentURI`), so other agents find it from the agent's on-chain identity:
`services: [{ "name": "MCP", "endpoint": "https://…/mcp", "version": "2025-11-25" }, { "name": "AgentPassportGate", "endpoint": "eip155:10143:<gate>" }]`.

## Tests
`npm test` — 20 tests: every tool over an in-memory MCP transport against real contracts on anvil
(policy refusals, output-schema validation by the client, execute_action success / pre-flight stop /
forced on-chain revert / counterparty outside the mandate / wrong signing key / revocation), plus the
HTTP guards and a real Streamable HTTP session.

A real LLM as the agent: see [`docs/AGENT_DEMO.md`](../docs/AGENT_DEMO.md) (`.mcp.json` in the repo root
wires this server into Claude Code).
