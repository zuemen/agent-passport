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

## Live run on Monad testnet

The full storyline, executed by `npm run scenario -w demo` on 2026-09-23 — every step, including the
rejected ones, is a real transaction (rejections revert on-chain with the gate's reason):

| | Role | Step | Gate reason | Tx |
|---|---|---|---|---|
| ✍️ | owner | Owner signs the authorization credential (EIP-712, off-chain) |  | off-chain |
| ✅ | owner | Anchor the credential hash and disclosure root on Monad |  | [`0x3be21847…`](https://testnet.monadscan.com/tx/0x3be218472c41f4bc068ef8ca341b4ea67ac07bac3b4045cc0b3d06d048ed3ef9) |
| ✅ | agent | Agent swaps 80 apUSD within its limit |  | [`0x3376e55c…`](https://testnet.monadscan.com/tx/0x3376e55c14c38587731fcbb7fa17891c2815ef2ccb92df542aa3686226dc3617) |
| ❌ | agent | Agent tries 150 apUSD — over its per-transaction limit | ExceedsPerTxLimit | [`0x73442f47…`](https://testnet.monadscan.com/tx/0x73442f47375e85e7b1d5f337afb3dccf6116f61110f72bf42929ee5783dbfd35) |
| ❌ | agent | Prompt-injected agent routes 50 apUSD through a look-alike DEX | PayeeNotAllowed | [`0xbb607e1c…`](https://testnet.monadscan.com/tx/0xbb607e1c8bb43a88fc90e9a32608c5756ca460987ddf9f787c5b9f18a5ca0681) |
| ❌ | agent | Agent pays a merchant that requires a vLEI-verified owner | OwnerNotVleiVerified | [`0xc1ba95e1…`](https://testnet.monadscan.com/tx/0xc1ba95e169e239ac7184fb9f8349f35cdb4f59b06892109951f4b1ed00562dbf) |
| ✅ | vlei | vLEI verifier records: owner is a verified legal entity |  | [`0x8abdad6f…`](https://testnet.monadscan.com/tx/0x8abdad6f7141a2dbf19810598878a263cbc246e074ef9b4631fe9c915575e2c3) |
| ✅ | agent | Same payment after the owner's vLEI is verified |  | [`0xc024a35e…`](https://testnet.monadscan.com/tx/0xc024a35e0bd6973a4aa3e7716f23f0eba114ac8bedc327b117223c8de017517e) |
| ✅ | owner | Owner revokes the credential |  | [`0xa2b7294d…`](https://testnet.monadscan.com/tx/0xa2b7294daed5ee0f6da1b5367d60731d91614e885324d71f1518a84ce5192075) |
| ❌ | agent | Agent swaps 10 apUSD after revocation | Revoked | [`0x52350221…`](https://testnet.monadscan.com/tx/0x5235022168c57d93b487c8925954c4c7320964d711fbfeda4ecacba3b0d42fa2) |

Median submit → receipt latency in this run: **827 ms**. The agent wallet held 0 apUSD throughout —
PassportGate pulls each authorized amount from the owner. Raw log: [`demo/public/runs/latest.json`](demo/public/runs/latest.json).

### Parallel actions
`npm run bench -w demo -- 8`: one agent submits 8 swaps at once. Each is fully verified on-chain —
identity, mandate status, four Merkle proofs, the agent's signature, the daily budget — and settled.
Result on 2026-09-23: **8/8 settled in 1 block**, 679 ms from first submit to
last receipt ([block 65043995](https://testnet.monadscan.com/block/65043995)). PassportGate's unordered nonces mean an
agent's actions never queue behind each other at the protocol level; this is what makes checking *every*
action practical. Raw data: [`demo/public/runs/bench-latest.json`](demo/public/runs/bench-latest.json).

### Passkey owner (no seed phrase)
`npm run passkey -w demo`: the owner is a `PasskeyAccount` ([`0x1722993f…`](https://testnet.monadscan.com/address/0x1722993fa8E14733977214c4D886E789Ae8FE637)) controlled by a
P-256 passkey; signatures are verified on-chain through Monad's P-256 precompile (`0x0100`, EIP-7951) and a
relayer pays the gas. The mandate is signed by the passkey (ERC-1271 issuer) and one prompt performs the
whole on-chain setup:

| | Step | Gate reason | Tx |
|---|---|---|---|
| ✍️ | Passkey signs the mandate (EIP-712 digest as WebAuthn challenge, ERC-1271 issuer) |  | off-chain |
| ✅ | One passkey prompt: register agent, bind key, fund, approve gate, anchor mandate |  | [`0xca381aa4…`](https://testnet.monadscan.com/tx/0xca381aa437bbb5c94f9cfd033b3aa311420f924fa0e6240306d97b2bd3477d0e) |
| ✅ | Agent swaps 10 apUSD from the passkey owner's funds |  | [`0x17fcad9c…`](https://testnet.monadscan.com/tx/0x17fcad9ceb8e7e98c033db71acec85a6e17fc221e2c6ef3a2c66e028b48a6179) |
| ✅ | Passkey prompt: revoke the mandate |  | [`0x1706dc4d…`](https://testnet.monadscan.com/tx/0x1706dc4d4dcc94e1831abe69c4407509d012625a4c644a86b9b5f7a120b6406f) |
| ❌ | Agent swaps 10 apUSD after the passkey revocation | Revoked | [`0x9706790f…`](https://testnet.monadscan.com/tx/0x9706790fbd8f9cab46fdf4fc9f2025f65bcff3cc66ba67cc8ae1265a9b270cbb) |

## Status
- [x] M1 — contracts, 87 Foundry tests (unit, revert paths, fuzz, invariant), deployed to Monad testnet
- [x] M2 — TypeScript SDK (issue, selectively disclose, verify, revoke), 14 tests incl. end-to-end on anvil
- [x] M3 — MCP server (`present_passport`, `verify_passport`, `check_authorization`), stdio + Streamable HTTP, 6 tests
- [x] M4 — end-to-end scenario on testnet, demo app (recorded + live mode)
- [ ] vLEI owner verification service (off-chain, see docs/VLEI_SETUP.md)
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
