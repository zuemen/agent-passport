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

## AI usage disclosure
Parts of this project are developed with AI coding assistants (Claude). All code is reviewed and owned by the team.

## License
MIT — see [LICENSE](LICENSE).
