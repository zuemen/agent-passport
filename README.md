# Agent Passport

Verifiable identity & selective-disclosure credentials for AI agents (ERC-8004).

> 🚧 Under active development for **Monad Metropolis** (Track 04 — Trust / Identity & AI Infrastructure).
> See [HACKATHON.md](HACKATHON.md) for scope, deadlines and rules.

## Problem
AI agents increasingly move money on-chain on behalf of people. A counterparty cannot tell **who** the agent is,
**who authorized it**, **how far** that authorization goes, or whether it has been **revoked** — without either
exposing the owner's private data or trusting a black box.

## Approach
1. **Identity** — ERC-8004 agent registries (identity, reputation, validation).
2. **Authorization credential** — the owner signs a W3C VC granting the agent caps, assets, expiry and scope.
3. **Selective disclosure** — each verifier sees only the fields its policy requires.
4. **Status & revocation** — credential hashes and revocation status on-chain; `PassportGate` lets any protocol
   check an agent before it acts.

## Why Monad
Agents act frequently; verifying identity and authorization on every action needs a fast, cheap, parallel EVM.

## Deployments — Monad testnet (chain id 10143)

All contracts are source-verified (Sourcify, exact match). Full list: [`contracts/deployments/10143.json`](contracts/deployments/10143.json).

| Contract | Address |
|---|---|
| PassportGate | [`0xb93Ddb5E34a2d8a16ebe3DA88851d4a805fFD109`](https://testnet.monadscan.com/address/0xb93Ddb5E34a2d8a16ebe3DA88851d4a805fFD109) |
| CredentialStatusRegistry | [`0xD1bC9758F76b6Ea18fbEE824a8Fe8A99c5fcC451`](https://testnet.monadscan.com/address/0xD1bC9758F76b6Ea18fbEE824a8Fe8A99c5fcC451) |
| AgentIdentityRegistry (ERC-8004) | [`0x5Df260dec1Ba15368f7fBe338D01a4C764CEAA51`](https://testnet.monadscan.com/address/0x5Df260dec1Ba15368f7fBe338D01a4C764CEAA51) |
| AgentReputationRegistry (ERC-8004) | [`0x726A215f33bE1Ca996Cf745D4ceee96b2d8f1EE7`](https://testnet.monadscan.com/address/0x726A215f33bE1Ca996Cf745D4ceee96b2d8f1EE7) |
| AgentValidationRegistry (ERC-8004) | [`0x35ab0e062A5BBfB64210Feb08FaE81969669dF76`](https://testnet.monadscan.com/address/0x35ab0e062A5BBfB64210Feb08FaE81969669dF76) |
| GroundedFeedback | [`0x39Bacd864318b7a6ea647A5fcE695523d823633f`](https://testnet.monadscan.com/address/0x39Bacd864318b7a6ea647A5fcE695523d823633f) |
| PasskeyAccountFactory | [`0x99B4CECeC7ce4efF9F2686dab74a2dCeb07766D4`](https://testnet.monadscan.com/address/0x99B4CECeC7ce4efF9F2686dab74a2dCeb07766D4) |
| PassportDex (demo) | [`0xEaa7574EBFaa724e0935476b4d4041B5Cf186DaC`](https://testnet.monadscan.com/address/0xEaa7574EBFaa724e0935476b4d4041B5Cf186DaC) |
| PassportMerchant (demo) | [`0xB66472725612bc98b0fa8262ec15eb2a5184Df10`](https://testnet.monadscan.com/address/0xB66472725612bc98b0fa8262ec15eb2a5184Df10) |
| apUSD (demo token) | [`0x3d3da601b45596FfC7aeB1B9346646e18DB151A8`](https://testnet.monadscan.com/address/0x3d3da601b45596FfC7aeB1B9346646e18DB151A8) |
| apWMON (demo token) | [`0x7A8D21f393B73D0371B0273FdFab7fde1A60245b`](https://testnet.monadscan.com/address/0x7A8D21f393B73D0371B0273FdFab7fde1A60245b) |

## Status
- [x] M1 — contracts, 87 Foundry tests (unit, revert paths, fuzz, invariant), deployed to Monad testnet
- [ ] M2 — TypeScript SDK (issue, selectively disclose, verify, revoke)
- [ ] M3 — MCP server (`present_passport`, `verify_passport`, `check_authorization`)
- [ ] M4 — demo app, end-to-end scenario on testnet; vLEI owner verification
- [ ] M5 — docs, architecture diagram, demo video

## Design reference
Concepts (field-level disclosure policies, assurance levels, revocation) are informed by the author's earlier
work on selective disclosure of health credentials (MedSSI). No code from that or any other earlier project is
used here; everything in this repository was written for Monad Metropolis, starting 2026-09-23.

## Future work
- Celo port
- Self Protocol Agent ID as an additional owner-assurance source
- ZK selective disclosure (prove `amount ≤ maxPerTx` without revealing the limit)

## AI usage disclosure
Parts of this project are developed with AI coding assistants (Claude). All code is reviewed and owned by the team.

## License
MIT — see [LICENSE](LICENSE).
