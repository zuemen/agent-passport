# Agent Passport — contracts

Foundry project. Solidity 0.8.28, OpenZeppelin 5.6.1, `via_ir`, EVM `cancun`.

| Contract | Role |
|---|---|
| `AgentIdentityRegistry` | ERC-8004 Identity Registry (agent NFT, registration URI, metadata, signed `agentWallet`) |
| `AgentReputationRegistry` | ERC-8004 Reputation Registry (minimal) |
| `AgentValidationRegistry` | ERC-8004 Validation Registry (minimal) |
| `CredentialStatusRegistry` | Anchors authorization credentials (VC hash + Merkle root of salted claims), revocation, expiry, kill switch, vLEI owner-assurance result |
| `PassportGate` | `check` / `isAuthorized` views and the enforcing `authorize` / `authorizeAndPull` |
| `PassportGuarded` | Base contract: integrate the gate in a few lines |
| `GroundedFeedback` | ERC-8004 feedback that can only be given for an action the gate authorized |
| `PasskeyAccount(+Factory)` | WebAuthn/passkey-controlled owner account (P-256 precompile `0x0100`) |
| `demo/*` | Mock tokens, `PassportDex`, `PassportMerchant` (testnet demo only) |

```bash
forge test                      # unit, fuzz and invariant tests
forge test --gas-report
set -a; source ../.env; set +a
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
```

Deployed addresses are written to `deployments/<chainId>.json`.
