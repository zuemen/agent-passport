# @agent-passport/mcp-server

An MCP server that lets any AI agent use Agent Passport — present its authorization, verify another
agent's, and ask PassportGate on Monad for a verdict before acting.

| Tool | Side | What it does |
|---|---|---|
| `present_passport(agentId, disclose[])` | agent | Selectively-disclosed presentation of the agent's credential. Empty `disclose` lists the claim names. Hidden claims never leave the agent. |
| `verify_passport(presentation, requiredScope?)` | verifier | Owner signature, Merkle membership of each disclosed claim, and on-chain status (Active / Revoked / Expired …, vLEI owner assurance). |
| `check_authorization(agentId, scope, amount, asset?, relyingParty?)` | either | Read-only call to `PassportGate.check` on Monad; returns the gate's reason code (`Ok`, `ExceedsPerTxLimit`, `Revoked`, `OwnerNotVleiVerified`, …). |

## Run
```bash
npm run build
# stdio (Claude Desktop / Claude Code / any MCP client)
PASSPORT_CREDENTIALS=./credentials node dist/index.js
# Streamable HTTP — the endpoint advertised in the agent's ERC-8004 registration file
PASSPORT_CREDENTIALS=./credentials node dist/index.js --http 8788   # -> http://localhost:8788/mcp
```

Without `PASSPORT_CREDENTIALS` the server runs in verifier-only mode (`verify_passport` works; the
agent-side tools refuse). Credentials are files written with `serializeCredential` from the SDK.

| Env | Default |
|---|---|
| `MONAD_RPC_URL` | `https://testnet-rpc.monad.xyz` |
| `PASSPORT_GATE`, `PASSPORT_STATUS_REGISTRY` | Monad testnet deployment |
| `PASSPORT_DEFAULT_ASSET`, `PASSPORT_DEFAULT_RELYING_PARTY` | demo apUSD, PassportDex |

Example client config:
```json
{ "mcpServers": { "agent-passport": { "command": "node", "args": ["<repo>/mcp-server/dist/index.js"],
  "env": { "PASSPORT_CREDENTIALS": "<repo>/mcp-server/credentials" } } } }
```

## Discovery
Put the HTTP endpoint in the agent's ERC-8004 registration file (`buildRegistrationFile` + `toDataUri`
in the SDK, then `setAgentURI`), so other agents find it from the agent's on-chain identity:
`services: [{ "name": "MCP", "endpoint": "https://…/mcp", "version": "2025-06-18" }, { "name": "AgentPassportGate", "endpoint": "eip155:10143:<gate>" }]`.

## Tests
`npm test` — the three tools over an in-memory MCP transport against real contracts on anvil.
