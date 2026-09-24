# @agent-passport/sdk

TypeScript SDK (viem) for Agent Passport: issue an authorization credential to an ERC-8004 agent,
disclose only the claims a verifier needs, verify presentations against Monad, and revoke.

```ts
import {
  issueCredential, anchorCredential, toGatePresentation, createPresentation,
  verifyPresentation, buildIntent, chainNow, signIntent, checkAuthorization, revokeCredential,
  MONAD_TESTNET,
} from "@agent-passport/sdk";

// Owner: issue and anchor
const held = await issueCredential({
  chainId: 10143,
  identityRegistry: MONAD_TESTNET.identityRegistry,
  statusRegistry: MONAD_TESTNET.credentialStatusRegistry,
  agentId: 1n,
  issuer: owner.address,
  scopes: ["dex.swap"],
  limits: [{ asset: MONAD_TESTNET.demoUsd, maxPerTx: 100_000_000n, dailyLimit: 250_000_000n }],
  payees: [MONAD_TESTNET.passportDex],
  validFrom, validUntil,
  text: { purpose: "Treasury rebalancing" },          // private, never disclosed on-chain
}, ownerWallet);
await anchorCredential(ownerWallet, MONAD_TESTNET.credentialStatusRegistry, held);

// Agent: act through a relying party (deadline from chainNow, not the local clock alone)
const intent = buildIntent({ credentialId: held.credentialId, scope: "dex.swap",
  asset: MONAD_TESTNET.demoUsd, amount: 80_000_000n, relyingParty: MONAD_TESTNET.passportDex,
  now: await chainNow(publicClient) });
const signature = await signIntent(agentAccount, 10143, MONAD_TESTNET.passportGate, intent);
const presentation = toGatePresentation(held, { scope: "dex.swap",
  asset: MONAD_TESTNET.demoUsd, relyingParty: MONAD_TESTNET.passportDex });
// -> PassportDex.swap(intent, presentation, signature, minOut)

// Anyone: pre-flight, or verify an off-chain presentation
await checkAuthorization(publicClient, MONAD_TESTNET.passportGate, { agentId: 1n, scope: "dex.swap", ... });
await verifyPresentation(createPresentation(held, ["scope:dex.swap"]), { client: publicClient });

// Owner: revoke — the next action is rejected
await revokeCredential(ownerWallet, MONAD_TESTNET.credentialStatusRegistry, held.credentialId, "rotated");
```

## Credential format
- W3C VC 2.0 (`AgentAuthorizationCredential`), issuer `did:pkh:eip155:<chainId>:<owner>`, proof
  `EthereumEip712Signature2021` over `AgentAuthorization{agentId, identityRegistry, issuer, disclosureRoot, validFrom, validUntil}`.
- `credentialId` = that EIP-712 digest; it is what `CredentialStatusRegistry` anchors.
- Each claim is `(salt, key, value)`, hashed into a sorted-pair Merkle tree (OpenZeppelin
  `StandardMerkleTree`, leaf types `bytes32×3`). Only the root is signed and anchored. A disclosure is
  the claim plus its Merkle proof — the SD-JWT salted-digest idea, verifiable on-chain.

Claim names: `scope:<scope>`, `maxPerTx:<asset>`, `dailyLimit:<asset>`, `payee:<relyingParty>`, `text:<name>`.

## Tests
`npm test` — unit tests (encoding pinned to the Solidity side) and an end-to-end run against the real
contracts on a local anvil chain (needs Foundry and `forge build` in `../contracts`).
