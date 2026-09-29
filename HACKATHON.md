# Agent Passport — Monad Metropolis submission

| | |
|---|---|
| Program | [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis) (Monad Foundation) |
| Track | 04 — Trust / Identity & AI Infrastructure |
| Repository | https://github.com/zuemen/agent-passport — MIT license |
| Network | Monad testnet (chain id 10143) — addresses in the [README](README.md#deployments--monad-testnet-chain-id-10143) and [`contracts/deployments/10143.json`](contracts/deployments/10143.json) |
| Demo video | https://youtu.be/5vyENgKpGrI — under 3 minutes, AI voice-over; it cuts together runs on Monad testnet from 2026-09-23 (the storyline, shown in the published demo page; the bench; the passkey owner; the vLEI result) and 2026-09-29 (Claude Code through MCP, two sessions), each labeled on screen |
| Live demo | https://zuemen.github.io/agent-passport/ — the recorded run, with live read-only reads from Monad testnet (live mode needs the local API: `npm run local -w demo`) |
| Check it yourself | [No keys, no MON](README.md#verify-it-yourself--no-keys-no-mon): one `curl` against Monad testnet, or the whole demo on a local chain under Monad's EVM rules |
| Adoption & plan | [docs/ADOPTION.md](docs/ADOPTION.md): first target adopters (with sources), alternatives, the 30/60/90-day plan; no external integration yet |

## For judges: using the live product (no login, no wallet, no test credentials needed)
Open **https://zuemen.github.io/agent-passport/** — it runs on Monad testnet (chain 10143) in any browser.
1. **Owner** tab — the mandate the owner signed: each claim marked "shown to DEX", "not shown" or "never leaves agent".
2. **Agent** tab — the agent's MCP session: the four tools and what each call returned, with its transactions.
3. **Verifier** tab — what the DEX sees (four Merkle-proven claims, the rest redacted). Press **Check authorization**
   to ask PassportGate on Monad right now (an `eth_call`, no transaction): this mandate was revoked on 2026-09-23, so
   the answer is `Revoked`, read live from the chain.
4. **Entries & refusals** — the 9 storyline transactions, each linked to MonadScan; 4 were refused on-chain.
5. **Check a refusal yourself** — paste any Monad testnet tx hash, or press one of the five buttons: the page reads
   the call trace from Monad's public RPC and decodes the gate's reason (`ExceedsPerTxLimit`, `PayeeNotAllowed`,
   `OwnerNotVleiVerified`, `Revoked`).

Sending your own transactions (live mode, passkey owner, your own MCP agent) needs no keys either:
`npm run local -w demo` runs everything on a local chain — see [Verify it yourself](README.md#verify-it-yourself--no-keys-no-mon).

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

Timeline, from the commit history (built with AI assistance, see below):
- 2026-09-23 — contracts and tests in one commit (`e8f16b0`), deployed to Monad testnet the same hour; then the SDK,
  MCP server, demo app, fork test and CI, the concurrent-actions bench, passkey owners and the vLEI verifier.
- 2026-09-24 — review rounds: claims narrowed to what the code shows, invariants and known limitations as tests,
  the scripted MCP run on testnet, the no-keys local mode, the mutation check.
- 2026-09-29 — review fixes, the published demo, Claude Code as the agent on testnet, the video.
The first four commits were made in GitHub's web editor while setting the repository up; their messages ran two
titles together.

## AI usage disclosure
Developed with AI coding assistance (Claude, via Claude Code) under the author's direction; see the
[README](README.md#ai-usage-disclosure) for details. All design decisions, code and deployments were reviewed
by the author, who is responsible for them.
