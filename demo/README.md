# Agent Passport — demo

React + Vite app with three roles — **Owner** (the institution: the mandate, vLEI status, revoke),
**Agent** (the recorded MCP session — tool calls, results, transactions — and live actions), **Verifier** (what the DEX sees: four proven claims, redacted rest,
and a live `PassportGate.check` on Monad).

```bash
npm run dev -w demo          # app on http://localhost:15173 (recorded run + live chain reads)
npm run api -w demo          # optional: live mode — the app then sends real testnet transactions
npm run scenario -w demo     # run the whole storyline on Monad testnet, write public/runs/latest.json
npm run local -w demo        # no keys, no MON: anvil + all contracts + live API + app, on a local chain
npm run scenario:local -w demo   # the same local chain, the whole storyline headless (also in CI)
```

Local mode uses anvil's public development accounts and writes only to `demo/.state-local/` and
`contracts/deployments/31337.json` (both git-ignored); the testnet records are never touched. On a local chain
there is no explorer, and the app hides the testnet-only benchmark and MCP panels and the passkey panel (plain
anvil has no P-256 precompile).

Live mode and the scenario read `DEMO_OWNER_KEY`, `DEMO_AGENT_KEY` and `DEPLOYER_PRIVATE_KEY` (the
registered vLEI verifier on testnet) from `../.env`. The API binds to 127.0.0.1 only. All data is
fictional test data — no real legal entity or LEI.
