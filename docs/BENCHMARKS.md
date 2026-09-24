# Benchmarks and test evidence

Every number below comes from a file in this repository or a command you can re-run. Commands that send
transactions spend testnet MON, are marked so, and run against the demo deployment with its demo keys.

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
execute in order within the block. The gate's unordered action nonces mean a refused action doesn't invalidate
the ones signed after it. Reproduce (sends transactions):
`npm run bench -w demo -- 8`.

## How a checked action meets Monad's execution model

What `PassportGate.authorize` writes, besides its event ([source](../contracts/src/PassportGate.sol)):

| Storage | Keyed by | Shared with |
|---|---|---|
| `nonceUsed` | agent wallet, action nonce | nothing — a fresh slot per action |
| `spent` | credential, asset, UTC day | every action under the same mandate and asset that day |
| `_actions` | action id | nothing — a fresh slot per action |

Everything else it only reads: the identity registry (owner, agent wallet), the status registry (the mandate's
record, the owner's vLEI status) and the relying party's vLEI requirement.
- **Different mandates don't contend in the gate.** Agents acting under different mandates write disjoint gate
  slots; their transactions can still meet in the relying party's own state (a DEX's reserves, a token balance),
  like any two swaps. Monad executes transactions optimistically in parallel and re-executes one whose inputs
  changed, so contention costs re-execution, not correctness.
- **One mandate is one budget line.** Actions under the same mandate and asset book the same `spent` slot, so they
  are ordered — what the concurrency run above measured. A benchmark with independent agents and mandates is
  future work.
- **A pre-check is only a preview.** The MCP server's `execute_action` calls `check` through `eth_call` before
  sending, which reads the last executed state; Monad orders a block by consensus and executes it afterwards, so the
  transaction runs against newer state. The gate checks everything again inside the transaction: a revoke that
  lands in between still refuses the action.

## Gas on Monad

Two Monad rules shape these numbers ([gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing),
[opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)):
- **The gas charged is the gas limit**, not the gas used. The MCP server's `execute_action` pre-checks every
  action with the gate's `check` and only sends what it accepts (unless forced; the signature, nonce and deadline
  are checked only on-chain); the demo scenario sends refused
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

## Gas under Foundry: Ethereum rules and Monad rules

`cd contracts && forge test --gas-report --no-match-contract GateInvariant`, then the same with `--network monad`,
which runs the tests under Foundry's Monad EVM (its gas schedule and precompiles). Foundry 1.8.3; the same tests
and the same calls in both columns; medians per function, including calls that revert inside the tests.

| Contract | Function | Ethereum (Cancun) | Monad | |
|---|---|---|---|---|
| PassportGate | `check` (view) | 45,323 | 67,252 | +48% |
| PassportGate | `authorize` | 175,035 | 237,471 | +36% |
| PassportGate | `authorizeAndPull` | 227,179 | 314,228 | +38% |
| CredentialStatusRegistry | `anchor` | 130,500 | 134,839 | +3% |
| CredentialStatusRegistry | `revoke` | 33,747 | 35,734 | +6% |
| CredentialStatusRegistry | `revokeAll` (kill switch) | 51,409 | 70,781 | +38% |
| CredentialStatusRegistry | `recordOwnerAssurance` | 68,331 | 69,866 | +2% |
| GroundedFeedback | `rate` | 33,519 | 50,961 | +52% |
| PassportDex (demo) | `swap` | 173,082 | 250,709 | +45% |
| PassportMerchant (demo) | `pay` | 133,025 | 205,759 | +55% |
| PasskeyAccount | `execute` (P-256 signature, batched calls) | 401,232 | 70,575 | **−82%** |

Two things show. Calls that read a lot of cold state cost more under Monad's rules (cold accounts and cold storage
pages, above): `check` calls the status and identity registries and reads several mapping entries. And a passkey
owner costs far less: Monad has the P-256 precompile at `0x0100`, while under Cancun rules OpenZeppelin's
`P256.verify` finds no precompile and verifies the signature in Solidity. On Monad testnet the precompile call in the passkey setup used 6,900 gas
([trace](../README.md#verify-it-yourself--no-keys-no-mon)).

## Test coverage

`cd contracts && FOUNDRY_INVARIANT_RUNS=8 forge coverage --ir-minimum --no-match-contract GateInvariant --report summary`
(the invariant suite is left out to keep the run short; the fork tests are skipped without `MONAD_FORK_URL`).

| Contract | Lines | Branches | Functions |
|---|---|---|---|
| PassportGate | 98.68% (75/76) | 88.46% (23/26) | 100% (14/14) |
| CredentialStatusRegistry | 94.64% (53/56) | 95.24% (20/21) | 100% (11/11) |
| AgentIdentityRegistry | 100% (55/55) | 90.00% (9/10) | 100% (15/15) |
| AgentReputationRegistry | 95.92% (47/49) | 85.71% (12/14) | 88.89% (8/9) |
| AgentValidationRegistry | 96.08% (49/51) | 83.33% (10/12) | 88.89% (8/9) |
| GroundedFeedback | 100% (11/11) | 100% (3/3) | 100% (2/2) |
| PasskeyAccount | 93.55% (29/31) | 100% (4/4) | 85.71% (6/7) |
| PassportGuarded | 100% (10/10) | 100% (2/2) | 100% (3/3) |
| PassportClaims | 100% (8/8) | — | 100% (4/4) |
| Demo contracts (PassportDex, PassportMerchant, MockToken) | 80.95% · 100% · 50% | 71.43% · 33.33% · — | 100% · 100% · 50% |
| **All of `src/`** | **95.36% (370/388)** | **87.25% (89/102)** | **93.98% (78/83)** |

Both `PassportGuarded` styles are covered: `_pullWithPassport` by the demo relying parties, `_requirePassport` by
the check-only example in [`contracts/test/examples/`](../contracts/test/examples). The totals count `src/` only
(forge's own "Total" also counts test helpers and scripts).

## Test suites

| Suite | Tests | Command |
|---|---|---|
| Contracts (unit, every gate reason code, fuzz, 3 invariants, check-only example, known limitations) | 99 | `cd contracts && forge test` |
| The same contract suite on Foundry's Monad EVM (Foundry 1.8+; in CI on every push) | 99 | `cd contracts && forge test --network monad` |
| Fork tests against the official ERC-8004 Identity and Reputation registries (in CI, skipped only when the public RPC is down) | 3 | `cd contracts && MONAD_FORK_URL=https://testnet-rpc.monad.xyz forge test --match-path "test/fork/*" --network monad` (Foundry 1.7 and older: without `--network monad`) |
| SDK (incl. end-to-end on anvil, passkey owners, deployment consistency, revert decoding, tampering) | 22 | `npm test -w sdk` |
| MCP server | 20 | `npm test -w mcp-server` |
| vLEI verifier | 6 | `npm test -w @agent-passport/verifier` |

Foundry 1.8 prints the three invariants as one test: `97 tests passed, 0 failed, 1 skipped` (the skip is the fork
suite when `MONAD_FORK_URL` is not set); Foundry 1.7 prints 99.

Static analysis: Slither 0.11.6, triage in [SECURITY.md](SECURITY.md#static-analysis-slither-0116).
