# Agent Passport — Monad Metropolis submission

| | |
|---|---|
| Program | [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis) (Monad Foundation) |
| Track | 04 — Trust / Identity & AI Infrastructure |
| Repository | https://github.com/zuemen/agent-passport — MIT license |
| Network | Monad testnet (chain id 10143) — addresses in the [README](README.md#deployments--monad-testnet-chain-id-10143) and [`contracts/deployments/10143.json`](contracts/deployments/10143.json) |
| Demo video | to be linked here |

## What it is
A primitive other protocols build on, so that before an AI agent moves money any protocol can check — in one
call on Monad — that its owner signed a mandate for it, what that mandate allows, and whether it still holds.
- ERC-8004 Identity / Reputation / Validation registries, fork-tested against the official Identity and Reputation registries
- An owner-signed W3C Verifiable Credential (the mandate): scopes, per-transaction and daily limits, allowed
  counterparties, validity — signed with EIP-712 or a passkey (ERC-1271)
- Field-level selective disclosure: salted-hash Merkle commitments; ZK range proofs are on the roadmap
- On-chain status and revocation, and `PassportGate`, which checks every action and, in the owner-funded style,
  pulls funds from the owner
- Owner accountability through vLEI verification; feedback grounded in gate-authorized actions (`GroundedFeedback`)
- An MCP server, so any agent can present its passport and act

## Build window
The repository was created on 2026-09-23 and everything in it was written during the hackathon period, as the
commit history shows. Design lineage (concepts only, re-implemented here): the author's MedSSI field-level
disclosure policies (Merit Award, Digital Credential Scenario Innovation Challenge, Ministry of Digital
Affairs, Taiwan, 2025). No code from MedSSI or any other earlier project is used.

## AI usage disclosure
Developed with AI coding assistance (Claude, via Claude Code) under the author's direction; see the
[README](README.md#ai-usage-disclosure) for details. All design decisions, code and deployments were reviewed
by the author, who is responsible for them.
