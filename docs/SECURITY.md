# Security notes

Hackathon code, not audited. This page states what the design defends against, what it does not, and
how the static-analysis findings were handled.

## Threat model

| Threat | Defence | Where |
|---|---|---|
| Agent tricked (prompt injection) into sending funds elsewhere | Agent wallet holds no funds; PassportGate pulls from the owner only for an allowed payee, scope, asset and amount | `authorizeAndPull`, `payee` claim |
| Agent exceeds its limits | Per-tx and daily limits are mandatory disclosed claims, enforced and booked on-chain | `PassportGate.check`, `spent` |
| Agent hides a restrictive claim | All four gate claims are required; missing/mismatched key → rejected | `_checkClaims` |
| Forged or lifted claims | Every disclosure is a Merkle proof against the root the owner anchored | `_proves`, SDK `verifyPresentation` |
| Replay of an action | EIP-712 intent bound to relying party, amount, asset, deadline; single-use unordered nonce | `ActionIntent`, `nonceUsed` |
| Presentation copied by a third party | Useless without the agent key: every action needs a fresh agent signature (key binding) | `_authorize` |
| Relying party inflates the amount | Amount is inside the signed intent | `test_revert_signatureForDifferentAmount` |
| Stale authority after revocation / expiry / sale of the agent | Checked on every call: revoked, time window, per-agent epoch (kill switch), issuer ≠ current owner | `CredentialStatusRegistry.statusOf` |
| Owner points agent at a wallet it doesn't control | `setAgentWallet` requires the new wallet's own signature (ECDSA or ERC-1271) | `AgentIdentityRegistry` |
| Sybil reputation | `GroundedFeedback`: one rating per gate-authorized action, only by its counterparty | `GroundedFeedback.rate` |
| Over-disclosure by the agent's MCP server | Disclosure policy (default: only the four gate claims); HTTP is verifier-only without a bearer token; Host/Origin validation | `mcp-server/src/policy.ts`, `http.ts` |
| Self-asserted "verified owner" | Only registered vLEI verifiers can record owner assurance; removing a verifier voids its results | `recordOwnerAssurance`, `ownerAssuranceOf` |

## Known limitations
- **Disclosed limits are revealed exactly.** Proving "limit ≥ amount" without revealing the limit needs a
  ZK range proof — roadmap.
- **Trust in the vLEI verifier.** The chain records the verifier's result, not the KERI/ACDC proof itself.
  The verifier set is admin-managed (`Ownable`) on testnet; a production system would govern it.
- **Salted claims are only as private as their salts.** The SDK uses 32 random bytes per claim.
- **Monad charges the gas limit.** Rejected actions sent on purpose (demo `forceSubmit`) still pay their gas.
- **Demo contracts** (`MockToken`, `PassportDex`, `PassportMerchant`) are for the testnet demo only.
  `MockToken.mint` is open by design.

## Static analysis (Slither 0.11.6)

`slither . --filter-paths "lib/|test/|script/" --exclude-informational --exclude-optimization`

Fixed:
- `PassportMerchant.pay`: order now reserved before the external call (was already `nonReentrant`).
- `PasskeyAccount.execute`: event emitted before the calls (effects before interactions).
- `PassportMerchant` constructor: zero-address check on the treasury.
- Explicit initialisation of summary accumulators.

Accepted (by design):
- *arbitrary-send-eth / calls-inside-a-loop* in `PasskeyAccount.execute` — it is a smart account that
  executes a batch of owner-signed calls; the passkey signature over the whole batch is the authorization.
- *timestamp* — validity windows, deadlines and daily buckets are time-based by definition; minute-level
  validator influence does not change any outcome that matters here.
- *unused-return* in `PassportGuarded._pullWithPassport` — the agent id is intentionally not needed.

The contracts deployed on Monad testnet on 2026-09-23 predate the three small fixes above; none of them
changes behaviour of the gate, registries or the demo flow.

## Tests
87 Foundry tests (unit, every revert path, fuzz, an invariant that today's booked spend never exceeds the
daily limit), 2 fork tests against the official ERC-8004 Identity Registry on Monad testnet, 15 SDK tests
(incl. end-to-end on anvil) and 19 MCP tests (incl. HTTP transport guards).
