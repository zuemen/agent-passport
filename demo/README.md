# Agent Passport — demo

React + Vite app with three roles — **Owner** (the institution: the mandate, vLEI status, revoke),
**Agent** (MCP tool calls, actions), **Verifier** (what the DEX sees: four proven claims, redacted rest,
and a live `PassportGate.check` on Monad).

```bash
npm run dev -w demo          # app on http://localhost:15173 (recorded run + live chain reads)
npm run api -w demo          # optional: live mode — the app then sends real testnet transactions
npm run scenario -w demo     # run the whole storyline on Monad testnet, write public/runs/latest.json
```

Live mode and the scenario read `DEMO_OWNER_KEY`, `DEMO_AGENT_KEY` and `DEPLOYER_PRIVATE_KEY` (the
registered vLEI verifier on testnet) from `../.env`. The API binds to 127.0.0.1 only. All data is
fictional test data — no real legal entity or LEI.
