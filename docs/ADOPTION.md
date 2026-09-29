# Adoption: who builds on Agent Passport, why, and what happens next

This page is for anyone deciding whether to put Agent Passport in front of their protocol, and for judges asking who
would. **Status, stated plainly: no external team has integrated Agent Passport yet.** Everything below marked
*target* is our reading of a project's public architecture, not a statement from that project. Sources were checked on
2026-09-29.

## The gap on Monad today
- Monad's Agent Hub lists platforms that accept payment from agents and says: *"Agents that control wallets can lose
  funds."* ([app.monad.xyz/agents](https://app.monad.xyz/agents))
- Its Discovery section carries 8 agent skill manifests (Uniswap, Morpho, Balancer, Kuru, Clober, Nad.fun, DevFun,
  Blinq.fi) and its API hub lists 66 x402 services ([api-hub](https://app.monad.xyz/agents/api-hub)).
- ERC-8004 says *"Payments are orthogonal to this protocol"* ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)):
  an agent has an identity, but nothing says what it may spend.
- The limits that exist live on the **wallet side** (MetaMask Advanced Permissions and Agent Wallet, ZeroDev and
  Biconomy session keys) or **off-chain** (policy databases). The protocol that receives the money cannot check them.

Agent Passport is the counterparty-side check: inside the payment, the receiving contract verifies that the agent's
owner signed a mandate for it, what that mandate allows, and whether it still holds.

## First targets
| Who | Why a check helps (our reading) | Where it goes | Source |
|---|---|---|---|
| **x402 API providers** on Monad's API hub (66 services) and the official facilitator | x402 settles *how* to pay; it does not show that the agent's owner allowed *this* spend on *this* API | Before the 402 is verified: one SDK `checkAuthorization` call (no contract change); on-chain, the pattern of our check-only example `PassportMeteredApi` | [docs.monad.xyz/guides/x402](https://docs.monad.xyz/guides/x402), [api-hub](https://app.monad.xyz/agents/api-hub) |
| **DeFi skills on the Agent Hub** — Kuru, Clober, then Morpho | Kuru's published skill builds its wallet client from a private key; its documented limits are a token allowlist and slippage, and no owner mandate or amount cap is described | The skill's prepare-then-sign step (SDK check, no gas), or a router that inherits `PassportGuarded` (our deployed `PassportDex` is the template) | [kuru-trading-skills](https://github.com/Kuru-Labs/kuru-trading-skills), [app.monad.xyz/agents](https://app.monad.xyz/agents) |
| **Agent platforms with scoped, revocable permissions** — Glider (ZeroDev session keys), CoinFello (MetaMask ERC-7710 delegation) | They already limit their agents, which shows the demand; the protocols their agents pay cannot verify those limits or who the owner is | The same policy, also signed as a Passport, so the protocols their agents call can verify it | [Glider](https://app.monad.xyz/app-hub/glider), [ZeroDev × Glider](https://www.zerodev.app/blogs/blog-zerodev-glider), [CoinFello](https://metamask.io/news/coinfello-metamask-smart-accounts-kit) |
| **Agentic treasuries** — aarna | Institutional capital run by agents needs to know which legal entity authorized it | Deposit / rebalance entry points with `_pullWithPassport` and a vLEI requirement for the scope | [aarna](https://app.monad.xyz/app-hub/aarna) |

## Why not roll their own — and why not the alternatives
Every protocol that wants this has to rebuild: owner signature checks (including P-256 passkeys), revocation that binds
everyone at once, daily-budget accounting, selective disclosure, and the binding to an ERC-8004 agent — and each agent
then signs a different thing for every protocol. **One Passport works with every guarded protocol**, in one call, with
14 tested reason codes ([INTEGRATION.md](INTEGRATION.md)).

| Alternative | What it does well | What it leaves open |
|---|---|---|
| MetaMask Advanced Permissions (ERC-7715/7710), live on Monad mainnet ([supported networks](https://docs.metamask.io/smart-accounts-kit/get-started/supported-networks/)) | Largest user base, UX built into MetaMask, limits enforced on-chain | Bound to the user's MetaMask smart account; the counterparty cannot see who the owner is or what the mandate says. **Complementary**: delegation limits the wallet, a Passport lets the counterparty verify |
| MetaMask Agent Wallet ([announcement](https://metamask.io/news/introducing-metamask-agent-wallet)) | Daily limits and allowlists out of the box, on Monad | Wallet-layer only; agents outside MetaMask cannot use it; counterparties cannot verify it |
| Session keys (ZeroDev, Biconomy — [Monad docs](https://docs.monad.xyz/tooling-and-infra/wallet-infra/smart-accounts)) | Mature, passkey-capable, flexible | A private account setting in each vendor's format, not a portable credential a third party can check |
| AP2 payment mandates ([ap2-protocol.org](https://ap2-protocol.org/)) | The richest mandate semantics, industry backing | Verified off-chain; a cumulative budget needs someone to keep the ledger — the gate keeps it on Monad. We align with AP2's open mandate constraints; we do not claim AP2 compliance |
| Off-chain policy engines | Fast to build | The counterparty has to trust the operator's database |

## Evidence so far
- Live on Monad testnet: 12 contracts source-verified on Sourcify, the storyline with 4 on-chain refusals, passkey owners, and
  Claude Code acting as the agent through MCP (two sessions, transcripts in `demo/public/runs/`).
- The published demo decodes any refusal from Monad's public RPC: https://zuemen.github.io/agent-passport/
- External integrations: **none yet**. Interest signals: none recorded yet. We will list every one here, with a link.

## Next 90 days
| When | Goal | Actions | Measured by |
|---|---|---|---|
| Days 0–30 | Mainnet, and zero-friction checks for APIs | Deploy to Monad mainnet on the official ERC-8004 registries; publish an x402 middleware (the check before the 402 is verified) and the SDK on npm; send integration PRs to x402 API providers and Agent Hub skills; publish an Agent Hub skill manifest; a public weekly ship log | 1 mainnet deployment · ≥2 x402 providers integrated · ≥5 external issues or PRs |
| Days 31–60 | Meet the wallet-side permissions | Convert an ERC-7715/7710 delegation or a session-key policy into a Passport in one step; a pilot with one agent platform; an external security review | ≥1 DeFi skill or router integration · ≥1 platform pilot · weekly on-chain presentation checks |
| Days 61–90 | Institutions and standards | A vLEI treasury pilot; propose a payment-authorization extension to the ERC-8004 authors | ≥5 guarded contracts · 1 extension proposal |

Channels: the [Monad Developer Discord](https://discord.gg/monaddev), the
[ERC-8004 best-practices repo](https://github.com/erc-8004/best-practices),
[Monad AI Blueprint](https://monad.xyz/blog/introducing-monad-ai-blueprint) and
[DeltaV](https://monad.xyz/developers/hackathons/metropolis).

## Integrate it today (a few lines)
Monad testnet, chain id 10143 — addresses in [`contracts/deployments/10143.json`](../contracts/deployments/10143.json).
- **Solidity**: inherit `PassportGuarded` and call `_pullWithPassport(intent, presentation, signature)` (or
  `_requirePassport` to only check) at the top of the function that moves money —
  [INTEGRATION.md §1](INTEGRATION.md#1-solidity--inherit-passportguarded).
- **TypeScript**: `checkAuthorization(client, gate, {...})` before you send; it is an `eth_call`, no gas —
  [§2](INTEGRATION.md#2-typescript--check-before-you-send).
- **An agent**: point any MCP client at the Agent Passport MCP server — [§3](INTEGRATION.md#3-mcp--any-agent).

Open an issue titled "Integration: <your project>" and we will help — and list you here.
