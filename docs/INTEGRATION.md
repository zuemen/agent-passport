# Integrating Agent Passport

Three ways to accept AI agents, from fully on-chain to agent-side. All addresses are in
[`contracts/deployments/10143.json`](../contracts/deployments/10143.json) and exported by the SDK as
`MONAD_TESTNET`.

| You are | Use | You get |
|---|---|---|
| A protocol (DEX, merchant, lender…) | Solidity: inherit `PassportGuarded` | Every agent action checked and budgeted on-chain before your code runs |
| An app or backend | TypeScript SDK: `checkAuthorization`, `verifyPresentation` | The gate's verdict without sending a transaction |
| An agent | MCP server: four tools | Present a passport, check, and act — without handing over private data |

## 1. Solidity — inherit `PassportGuarded`

[`PassportGuarded`](../contracts/src/PassportGuarded.sol) offers two styles:

| | `_pullWithPassport` | `_requirePassport` |
|---|---|---|
| Funds | The gate transfers `intent.amount` of `intent.asset` **from the agent's owner to your contract** | You take funds as you normally would (typically from the agent wallet) |
| Returns | `(actionId, payer)` — `payer` is the owner | `(actionId, agentId)` |
| Gate call | `PassportGate.authorizeAndPull` | `PassportGate.authorize` |
| Example | [`PassportMerchant`](../contracts/src/demo/PassportMerchant.sol), [`PassportDex`](../contracts/src/demo/PassportDex.sol) (deployed) | [`PassportMeteredApi`](../contracts/test/examples/PassportMeteredApi.sol) (a pay-per-call API billing the agent's own wallet; test-only) |

Either way the transaction sender must be the agent wallet registered for the credential's agent
(`CallerIsNotAgent` otherwise), and the gate reverts with `NotAuthorized(reason)` if the action is not allowed.

A complete relying party, from [`contracts/src/demo/PassportMerchant.sol`](../contracts/src/demo/PassportMerchant.sol)
(abridged; this is the current source — the testnet deployment predates its treasury check and order reservation,
see the README's deployment notes):

```solidity
contract PassportMerchant is PassportGuarded, ReentrancyGuard {
    bytes32 public constant PAY_SCOPE = keccak256("commerce.pay");

    constructor(PassportGate gate, address treasury_) PassportGuarded(gate) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = treasury_;
        gate.setVleiRequirement(PAY_SCOPE, true);
    }

    function pay(
        bytes32 orderId,
        PassportGate.ActionIntent calldata intent,
        PassportGate.Presentation calldata presentation,
        bytes calldata agentSignature
    ) external nonReentrant {
        if (intent.scope != PAY_SCOPE) revert WrongScope();
        if (paidOrders[orderId] != bytes32(0)) revert OrderAlreadyPaid();
        // Reserve the order before any external call (checks-effects-interactions).
        paidOrders[orderId] = bytes32(uint256(1));
        (bytes32 actionId,) = _pullWithPassport(intent, presentation, agentSignature);
        paidOrders[orderId] = actionId;
        emit OrderPaid(orderId, actionId, msg.sender, intent.amount);
        IERC20(intent.asset).safeTransfer(treasury, intent.amount);
    }
}
```

Checklist:
1. **Fix your scope.** Pick a scope string per kind of action (`"dex.swap"`, `"commerce.pay"`) and require
   `intent.scope == keccak256(scope)`. The gate proves the mandate grants `intent.scope`; your contract decides
   which scope the function represents.
2. **Optionally require an accountable owner.** `gate.setVleiRequirement(scope, true)`, called by your
   contract (the relying party is `msg.sender`), makes the gate refuse owners without a recorded vLEI
   verification. You learn that the owner is verified, not who it is.
3. **Owner-funded? The owner approves the gate once.** For `_pullWithPassport`, the owner calls
   `approve(PassportGate, amount)` on the asset; the demo does this at setup
   ([`demo/scenario/scenario.ts`](../demo/scenario/scenario.ts), step "Owner lets PassportGate pull funds") with an
   unlimited amount for convenience — in production approve only what the active mandates can spend.
4. **Keep the `actionId`.** It identifies the authorized action; the counterparty of that action — and only it
   — can rate the agent once through `GroundedFeedback`.

Behaviour to copy in your tests: [`contracts/test/DemoScenario.t.sol`](../contracts/test/DemoScenario.t.sol) —
`test_story_withinLimit_overLimit_revoke`, `test_promptInjection_lookalikeDexRejected`,
`test_revert_callerIsNotAgent`, `test_merchant_requiresVerifiedOwner`,
`test_settledSwapsBuildGroundedReputation`; for the check-only style,
[`contracts/test/examples/PassportMeteredApi.t.sol`](../contracts/test/examples/PassportMeteredApi.t.sol) — the agent pays
from its own wallet, and the gate still books every call against the owner's daily limit
(`test_checkOnly_dailyLimitIsBooked`).

### What the gate checks, and why it says no

Besides the reason codes, `_authorize` reverts with its own errors when the caller is not
`intent.relyingParty` (`WrongRelyingParty`), the intent is past its deadline (`IntentExpired`), the intent and
presentation name different credentials (`CredentialMismatch`), the nonce was used (`NonceAlreadyUsed`), or the
agent's EIP-712 signature does not verify for its registered wallet, EOA or ERC-1271 (`InvalidAgentSignature`).
`PassportGate.check` returns one `Reason`
([`contracts/src/PassportGate.sol`](../contracts/src/PassportGate.sol), `enum Reason`):

| Reason | Meaning |
|---|---|
| `Ok` | Authorized |
| `UnknownCredential` | The credential was never anchored |
| `Revoked` | The owner revoked this mandate |
| `Expired` / `NotYetValid` | Outside the mandate's validity window |
| `Superseded` | The owner revoked all of the agent's mandates at once (kill switch: the agent's epoch moved on) |
| `IssuerNotOwner` | The agent NFT changed hands; the old owner's mandates stop counting |
| `WrongAgent` | The credential belongs to another agent, or the agent has no wallet |
| `BadDisclosure` | A disclosed claim does not prove against the anchored Merkle root |
| `ScopeNotGranted` | The mandate does not grant this scope |
| `AssetNotGranted` | The mandate sets no limits for this asset |
| `PayeeNotAllowed` | This relying party is not an allowed counterparty (e.g. a look-alike contract) |
| `ExceedsPerTxLimit` | Amount above the per-transaction limit |
| `ExceedsDailyLimit` | Amount would exceed today's budget (booked on-chain on every authorized action) |
| `OwnerNotVleiVerified` | The relying party requires a vLEI-verified owner for this scope |

The four disclosed claims (scope, per-tx limit, daily limit, "this relying party is allowed") travel in
calldata, so they are public once an action executes; the mandate's other claims stay private.

## 2. TypeScript — check before you send

The SDK (`@agent-passport/sdk`, the `sdk/` workspace; viem) builds and signs the same call the demo sends
([`demo/scenario/scenario.ts`](../demo/scenario/scenario.ts), `swap`); `held` is the agent's credential
(`deserializeCredential`):

```ts
import { MONAD_TESTNET as C, buildIntent, signIntent, toGatePresentation, checkAuthorization, passportDexAbi } from "@agent-passport/sdk";

// The agent: sign one action and select the four claims the gate needs.
const intent = buildIntent({ credentialId: held.credentialId, scope: "dex.swap", asset: C.demoUsd, amount, relyingParty: C.passportDex });
const signature = await signIntent(agentAccount, 10143, C.passportGate, intent);
const presentation = toGatePresentation(held, { scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex });

// Anyone: the gate's verdict, read-only.
const { authorized, reason } = await checkAuthorization(publicClient, C.passportGate, {
  agentId, scope: "dex.swap", asset: C.demoUsd, amount, relyingParty: C.passportDex, presentation,
});

// The agent sends it; the DEX calls the gate inside the same transaction.
if (authorized) await agentWallet.writeContract({ address: C.passportDex, abi: passportDexAbi, functionName: "swap", args: [intent, presentation, signature, 0n] });
```

Without the gate, `verifyPresentation` ([`sdk/src/verify.ts`](../sdk/src/verify.ts)) checks the owner's signature,
each disclosed claim and — given a client — that the credential is anchored and Active on Monad;
`credentialStatus` reads a credential's status and owner assurance.

## 3. MCP — any agent

[`mcp-server/`](../mcp-server) exposes four tools over stdio or Streamable HTTP:

| Tool | Does |
|---|---|
| `present_passport` | Builds a presentation for a counterparty, limited by the disclosure policy (default: only the four gate claims) |
| `verify_passport` | Verifies a presentation: the owner's signature, each disclosed claim against the credential, and that the credential is Active on Monad |
| `check_authorization` | Asks `PassportGate.check` whether an action would pass |
| `execute_action` | Pre-checks the action against `PassportGate`, then signs and sends it as the agent (needs `PASSPORT_AGENT_KEY`) |

It runs in agent mode when `PASSPORT_CREDENTIALS` points at the agent's credentials; over HTTP it is
verifier-only unless a bearer token is set. The repository's [`.mcp.json`](../.mcp.json) wires it into Claude
Code; the full walkthrough, including a prompt-injection attempt, is in [AGENT_DEMO.md](AGENT_DEMO.md).
