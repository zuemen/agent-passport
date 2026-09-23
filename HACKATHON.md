# Agent Passport — Hackathon / Grant Tracking

> 本 repo 為 **Monad Metropolis** 的參賽作品。
> Repo 建立於 2026-09-23，所有程式碼皆為 Monad Metropolis 賽期（2026-09-01 起）內新寫，可由 commit 歷史驗證。

| Program | Branch | Target | Deadline |
|---|---|---|---|
| [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis) | `main` | Track 04 — Trust / Identity & AI Infrastructure | 2026-10-13（評審 10/14–27，11/3 公布） |

## What we are building
**Verifiable identity & selective-disclosure credentials for AI agents.**
- ERC-8004 Identity / Reputation / Validation registries for agents
- Owner-issued W3C Verifiable Credential authorizing an agent (spend caps, allowed assets, expiry, scope)
- Field-level selective disclosure (salted-hash commitments, SD-JWT style; ZK proofs on the roadmap)
- On-chain credential status & revocation, and a `PassportGate` check other protocols can call before an agent acts

Design lineage (concepts only, re-implemented here): MedSSI field-level disclosure policies
(Merit Award, Digital Credential Scenario Innovation Challenge, Ministry of Digital Affairs, Taiwan, 2025).

## Rules to remember (Monad)
- Everything shown on 13 Oct must be built during the six-week window — keep all work in commits here.
- ⚠️ Re-check on hackathon.monad.xyz: OSI license (this repo: MIT), ≤3-min demo video showing real Monad testnet
  interactions, disclose AI-tool usage in README, one project per participant, one track.

## AI usage disclosure
Parts of this project are developed with AI coding assistants (Claude). All code is reviewed and owned by the team.
