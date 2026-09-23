# Benchmarks and test evidence

Every number below comes from a file in this repository or a command you can re-run. Commands that send
transactions spend testnet MON and are marked so.

## Latency on Monad testnet

The recorded storyline (2026-09-23, [`demo/public/runs/latest.json`](../demo/public/runs/latest.json)), timed by
the scenario script from submit to receipt — from a laptop in Taiwan to the public RPC, so network round trips
are included.

| Step | Outcome | Submit → receipt |
|---|---|---|
| Owner anchors the mandate | recorded | 865 ms |
| Agent swaps 80 apUSD | granted | 787 ms |
| Agent tries 150 apUSD | refused — `ExceedsPerTxLimit` | 830 ms |
| Prompt-injected agent pays a look-alike DEX | refused — `PayeeNotAllowed` | 844 ms |
| Agent pays a merchant that requires a vLEI-verified owner | refused — `OwnerNotVleiVerified` | 780 ms |
| vLEI verifier records the owner | recorded | 853 ms |
| Same payment | granted | 792 ms |
| Owner revokes the mandate | recorded | 827 ms |
| Agent swaps after revocation | refused — `Revoked` | 784 ms |

Median **827 ms**, range 780–865 ms. Reproduce (sends transactions): `npm run scenario -w demo`.

## Concurrent actions

One agent signs 8 swaps and submits them back to back without waiting for receipts; each is fully verified by
the gate ([`demo/public/runs/bench-latest.json`](../demo/public/runs/bench-latest.json)):

| | |
|---|---|
| Settled | 8 / 8, all in block [65043995](https://testnet.monadscan.com/block/65043995) |
| Time to submit all 8 | 304 ms |
| First submit → last receipt | **679 ms** |

The swaps come from one wallet (consecutive transaction nonces) and book the same daily-budget slot, so they
execute in order within the block. What the gate's unordered action nonces remove is the wait between actions:
the agent never needs a receipt before signing the next one. Reproduce (sends transactions):
`npm run bench -w demo -- 8`.

## Gas on Monad

Two Monad rules shape these numbers ([gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing),
[opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)):
- **The gas charged is the gas limit**, not the gas used. The MCP server's `execute_action` pre-checks every
  action against the gate and only sends what it will accept (unless forced); the demo scenario sends refused
  actions anyway, with a fixed 400,000 limit, so that the refusals are recorded on-chain.
- **Cold state access costs more than on Ethereum**: 10,100 gas per cold account (Ethereum: 2,600) and 8,100
  per cold 128-slot storage page (Ethereum: 2,100 per slot). A guarded action reads the gate, the status
  registry, the identity registry and the token, and mapping entries that each sit on their own storage page.

| Measurement | Gas | Cost at 102 MON-gwei | Source |
|---|---|---|---|
| `PassportGate.check`, standalone call — `dex.swap` | 122,079 | — | `npm run gas -w demo` (read-only `eth_estimateGas`; includes the 21,000 base cost and calldata) |
| `PassportGate.check`, standalone call — `commerce.pay`, vLEI required | 132,156 | — | same |
| Guarded swap in the scenario (limit = estimate + 25%) | 753,763 | 0.0769 MON | [tx 0x3376e55c…](https://testnet.monadscan.com/tx/0x3376e55c14c38587731fcbb7fa17891c2815ef2ccb92df542aa3686226dc3617) |
| Guarded swap in the concurrency run (limit = estimate + 25%) | 618,665 | 0.0631 MON | [tx 0xbbbd01d4…](https://testnet.monadscan.com/tx/0xbbbd01d461ed9dc35c0c90a85ce01698d6818f07df019206d9cdbc7435f71b07) |
| Refused action, sent anyway with a fixed limit | 400,000 | 0.0408 MON | [tx 0xbb607e1c…](https://testnet.monadscan.com/tx/0xbb607e1c8bb43a88fc90e9a32608c5756ca460987ddf9f787c5b9f18a5ca0681) |
| Revocation | 45,315 | 0.0046 MON | [tx 0xa2b7294d…](https://testnet.monadscan.com/tx/0xa2b7294daed5ee0f6da1b5367d60731d91614e885324d71f1518a84ce5192075) |

Monad's documentation puts a 200,000-gas transaction at about $0.0005 at the minimum base fee, so a fully
checked agent payment costs a fraction of a cent. The obvious optimisation — keeping a credential's gate state
on fewer storage pages — is future work; the deployed contracts are unchanged.

## Gas under Foundry (Ethereum gas schedule, local EVM)

`cd contracts && forge test --gas-report --no-match-contract GateInvariant` — per-function gas across the unit
tests. Medians include calls that revert inside the tests.

| Contract | Function | Median | Max |
|---|---|---|---|
| PassportGate | `check` (view) | 40,563 | 48,718 |
| PassportGate | `authorize` | 101,250 | 192,873 |
| PassportGate | `authorizeAndPull` | 224,379 | 224,379 |
| CredentialStatusRegistry | `anchor` | 130,500 | 130,512 |
| CredentialStatusRegistry | `revoke` | 30,148 | 33,903 |
| CredentialStatusRegistry | `revokeAll` (kill switch) | 51,409 | 51,409 |
| CredentialStatusRegistry | `recordOwnerAssurance` | 64,225 | 95,595 |
| GroundedFeedback | `rate` | 31,337 | 33,519 |
| PassportDex (demo) | `swap` | 173,082 | 448,009 |
| PassportMerchant (demo) | `pay` | 133,025 | 261,232 |
| PasskeyAccount | `execute` (P-256 signature, batched calls) | 401,232 | 665,407 |

## Test coverage

`cd contracts && FOUNDRY_INVARIANT_RUNS=8 forge coverage --ir-minimum --no-match-contract GateInvariant --report summary`
(the invariant suite is left out to keep the run short; the fork test is skipped without `MONAD_FORK_URL`).

| Contract | Lines | Branches | Functions |
|---|---|---|---|
| PassportGate | 98.68% (75/76) | 88.46% (23/26) | 100% (14/14) |
| CredentialStatusRegistry | 94.64% (53/56) | 95.24% (20/21) | 100% (11/11) |
| AgentIdentityRegistry | 100% (55/55) | 90.00% (9/10) | 100% (15/15) |
| AgentReputationRegistry | 95.92% (47/49) | 85.71% (12/14) | 88.89% (8/9) |
| AgentValidationRegistry | 96.08% (49/51) | 83.33% (10/12) | 88.89% (8/9) |
| GroundedFeedback | 100% (11/11) | 100% (3/3) | 100% (2/2) |
| PasskeyAccount | 93.55% (29/31) | 100% (4/4) | 85.71% (6/7) |
| PassportGuarded | 60.00% (6/10) | 50.00% (1/2) | 66.67% (2/3) |
| PassportClaims | 100% (8/8) | — | 100% (4/4) |
| Demo contracts (PassportDex, PassportMerchant, MockToken) | 80.95% · 100% · 50% | 71.43% · 33.33% · — | 100% · 100% · 50% |
| **All** | **84.67% (453/535)** | **82.41% (89/108)** | **91.00% (91/100)** |

`PassportGuarded` is low because both demo relying parties use the owner-funded `_pullWithPassport`; the
check-only `_requirePassport` path has no test yet.

## Test suites

| Suite | Tests | Command |
|---|---|---|
| Contracts (unit, every revert path, fuzz, invariant) | 87 | `cd contracts && forge test` |
| Fork tests against the official ERC-8004 deployment | 2 | `MONAD_FORK_URL=https://testnet-rpc.monad.xyz forge test --match-path "test/fork/*"` |
| SDK (incl. end-to-end on anvil, passkey owners) | 18 | `npm test -w sdk` |
| MCP server | 19 | `npm test -w mcp-server` |
| vLEI verifier | 6 | `npm test -w @agent-passport/verifier` |

Static analysis: Slither 0.11.6, triage in [SECURITY.md](SECURITY.md#static-analysis-slither-0116).
