// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";
import {CredentialStatusRegistry} from "./CredentialStatusRegistry.sol";
import {PassportClaims} from "./libraries/PassportClaims.sol";

/// @title PassportGate
/// @notice The check any protocol runs before letting an AI agent act: is this agent who it says it
///         is, did its owner authorize *this* action with *this* counterparty, is that authorization
///         still live, and is it within limits — while learning only the claims the action needs.
///
///         The credential is an owner-signed mandate (aligned with the constraint semantics of an AP2
///         open Payment Mandate: amount range, budget per period, allowed payees, validity window, and
///         a bound agent key). Its claims are committed to on-chain as a Merkle root of salted digests;
///         a presentation reveals four of them:
///             scope · maxPerTx[asset] · dailyLimit[asset] · payee[relyingParty]
///
///         `check` / `isAuthorized` are free pre-flight views.
///         `authorize` enforces: fresh agent signature over the exact action (key binding), single-use
///         nonce, the relying party's vLEI requirement, and the daily budget, which it books.
///         `authorizeAndPull` also moves the funds from the agent's owner to the relying party, so the
///         agent wallet never holds money — an agent that is tricked (e.g. by prompt injection) has
///         nothing to move outside what its owner signed.
contract PassportGate is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Disclosure {
        bytes32 salt;
        bytes32 key;
        bytes32 value;
        bytes32[] proof;
    }

    struct Presentation {
        bytes32 credentialId;
        Disclosure scope;
        Disclosure maxPerTx;
        Disclosure dailyLimit;
        Disclosure payee;
    }

    /// @notice What the agent signs. `relyingParty` is the contract that will call `authorize`, so a
    ///         signature given to one protocol cannot be spent at another.
    struct ActionIntent {
        bytes32 credentialId;
        bytes32 scope;
        address asset;
        uint256 amount;
        address relyingParty;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Every authorized action, so feedback can be tied to something that really happened.
    struct Action {
        uint256 agentId;
        address relyingParty;
        uint64 timestamp;
    }

    enum Reason {
        Ok,
        UnknownCredential,
        Revoked,
        Expired,
        NotYetValid,
        Superseded,
        IssuerNotOwner,
        WrongAgent,
        BadDisclosure,
        ScopeNotGranted,
        AssetNotGranted,
        PayeeNotAllowed,
        ExceedsPerTxLimit,
        ExceedsDailyLimit,
        OwnerNotVleiVerified
    }

    bytes32 public constant ACTION_INTENT_TYPEHASH = keccak256(
        "ActionIntent(bytes32 credentialId,bytes32 scope,address asset,uint256 amount,address relyingParty,uint256 nonce,uint256 deadline)"
    );

    IAgentIdentity public immutable identityRegistry;
    CredentialStatusRegistry public immutable statusRegistry;

    /// Unordered nonces: an agent can have many actions in flight at once, each with its own random
    /// nonce, instead of queueing behind a counter — this is what lets agents use parallel execution.
    mapping(address agentWallet => mapping(uint256 nonce => bool)) public nonceUsed;
    mapping(bytes32 credentialId => mapping(address asset => mapping(uint256 day => uint256))) public spent;
    /// A relying party may require, per scope, that the agent's owner is a vLEI-verified legal entity.
    /// It learns that the owner is verified, not who the owner is.
    mapping(address relyingParty => mapping(bytes32 scope => bool)) public requiresVlei;
    mapping(bytes32 actionId => Action) private _actions;

    event AgentActionAuthorized(
        bytes32 indexed actionId,
        uint256 indexed agentId,
        address indexed relyingParty,
        bytes32 credentialId,
        address agentWallet,
        bytes32 scope,
        address asset,
        uint256 amount
    );
    event VleiRequirementSet(address indexed relyingParty, bytes32 indexed scope, bool required);

    error NotAuthorized(Reason reason);
    error WrongRelyingParty();
    error IntentExpired();
    error CredentialMismatch();
    error NonceAlreadyUsed();
    error InvalidAgentSignature();

    constructor(IAgentIdentity identityRegistry_, CredentialStatusRegistry statusRegistry_)
        EIP712("AgentPassportGate", "1")
    {
        identityRegistry = identityRegistry_;
        statusRegistry = statusRegistry_;
    }

    // ------------------------------------------------------------------ relying-party policy

    /// @notice The caller (a relying party) requires a vLEI-verified owner for `scope`.
    function setVleiRequirement(bytes32 scope, bool required) external {
        requiresVlei[msg.sender][scope] = required;
        emit VleiRequirementSet(msg.sender, scope, required);
    }

    // ------------------------------------------------------------------ views

    /// @notice One-call answer for a protocol: may agent `agentId` do `amount` of `asset` under `scope`
    ///         at `relyingParty`, given presentation `p`?
    function isAuthorized(
        uint256 agentId,
        bytes32 scope,
        address asset,
        uint256 amount,
        address relyingParty,
        Presentation calldata p
    ) external view returns (bool) {
        return check(agentId, scope, asset, amount, relyingParty, p) == Reason.Ok;
    }

    /// @notice Why (or whether) the action is authorized: registered + active + disclosed claims prove
    ///         the scope, asset, limits and payee + (if the relying party requires it for this scope)
    ///         a vLEI-verified owner.
    function check(
        uint256 agentId,
        bytes32 scope,
        address asset,
        uint256 amount,
        address relyingParty,
        Presentation calldata p
    ) public view returns (Reason) {
        CredentialStatusRegistry.Status status = statusRegistry.statusOf(p.credentialId);
        if (status != CredentialStatusRegistry.Status.Active) return _statusReason(status);

        CredentialStatusRegistry.Credential memory cred = statusRegistry.getCredential(p.credentialId);
        if (cred.agentId != agentId || identityRegistry.getAgentWallet(agentId) == address(0)) {
            return Reason.WrongAgent;
        }

        Reason r = _checkClaims(cred.disclosureRoot, relyingParty, scope, asset, p);
        if (r != Reason.Ok) return r;

        if (amount > uint256(p.maxPerTx.value)) return Reason.ExceedsPerTxLimit;
        if (spent[p.credentialId][asset][_today()] + amount > uint256(p.dailyLimit.value)) {
            return Reason.ExceedsDailyLimit;
        }
        if (
            requiresVlei[relyingParty][scope]
                && statusRegistry.ownerAssuranceOf(p.credentialId) != CredentialStatusRegistry.OwnerAssurance.VLEI_VERIFIED
        ) {
            return Reason.OwnerNotVleiVerified;
        }
        return Reason.Ok;
    }

    function spentToday(bytes32 credentialId, address asset) external view returns (uint256) {
        return spent[credentialId][asset][_today()];
    }

    function getAction(bytes32 actionId) external view returns (Action memory) {
        return _actions[actionId];
    }

    /// @notice EIP-712 digest the agent signs; also the action's id once authorized.
    function hashIntent(ActionIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ACTION_INTENT_TYPEHASH,
                    intent.credentialId,
                    intent.scope,
                    intent.asset,
                    intent.amount,
                    intent.relyingParty,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    // ------------------------------------------------------------------ enforcement

    /// @notice Called by a relying party before executing an agent's action. Reverts unless the action
    ///         is authorized; on success records it and returns who acted.
    function authorize(ActionIntent calldata intent, Presentation calldata p, bytes calldata agentSignature)
        external
        nonReentrant
        returns (bytes32 actionId, uint256 agentId, address agentWallet)
    {
        (actionId, agentId, agentWallet,) = _authorize(intent, p, agentSignature);
    }

    /// @notice `authorize`, then transfer `intent.amount` of `intent.asset` from the agent's owner (the
    ///         credential issuer, who has approved this gate) to the relying party.
    function authorizeAndPull(ActionIntent calldata intent, Presentation calldata p, bytes calldata agentSignature)
        external
        nonReentrant
        returns (bytes32 actionId, uint256 agentId, address agentWallet, address payer)
    {
        (actionId, agentId, agentWallet, payer) = _authorize(intent, p, agentSignature);
        // ---- interaction, after all state is written
        IERC20(intent.asset).safeTransferFrom(payer, msg.sender, intent.amount);
    }

    function _authorize(ActionIntent calldata intent, Presentation calldata p, bytes calldata agentSignature)
        private
        returns (bytes32 actionId, uint256 agentId, address agentWallet, address payer)
    {
        // ---- checks
        if (msg.sender != intent.relyingParty) revert WrongRelyingParty();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (intent.credentialId != p.credentialId) revert CredentialMismatch();

        CredentialStatusRegistry.Credential memory cred = statusRegistry.getCredential(p.credentialId);
        if (cred.issuer == address(0)) revert NotAuthorized(Reason.UnknownCredential);
        agentId = cred.agentId;
        payer = cred.issuer;
        agentWallet = identityRegistry.getAgentWallet(agentId);

        if (nonceUsed[agentWallet][intent.nonce]) revert NonceAlreadyUsed();
        actionId = hashIntent(intent);
        if (agentWallet == address(0) || !SignatureChecker.isValidSignatureNow(agentWallet, actionId, agentSignature)) {
            revert InvalidAgentSignature();
        }

        Reason reason = check(agentId, intent.scope, intent.asset, intent.amount, msg.sender, p);
        if (reason != Reason.Ok) revert NotAuthorized(reason);

        // ---- effects
        nonceUsed[agentWallet][intent.nonce] = true;
        spent[p.credentialId][intent.asset][_today()] += intent.amount;
        _actions[actionId] = Action(agentId, msg.sender, uint64(block.timestamp));

        emit AgentActionAuthorized(
            actionId, agentId, msg.sender, p.credentialId, agentWallet, intent.scope, intent.asset, intent.amount
        );
    }

    // ------------------------------------------------------------------ internal

    /// @dev Each disclosed claim must have the key this action requires and be part of the credential.
    ///      All four are mandatory, so an agent cannot dodge a limit by not disclosing it.
    function _checkClaims(bytes32 root, address relyingParty, bytes32 scope, address asset, Presentation calldata p)
        private
        pure
        returns (Reason)
    {
        if (p.scope.key != PassportClaims.KEY_SCOPE || !_proves(root, p.scope)) return Reason.BadDisclosure;
        if (p.scope.value != scope) return Reason.ScopeNotGranted;

        // The per-tx limit existing for `asset` is what grants the asset.
        if (p.maxPerTx.key != PassportClaims.maxPerTxKey(asset)) return Reason.AssetNotGranted;
        if (!_proves(root, p.maxPerTx)) return Reason.BadDisclosure;
        if (p.dailyLimit.key != PassportClaims.dailyLimitKey(asset)) return Reason.AssetNotGranted;
        if (!_proves(root, p.dailyLimit)) return Reason.BadDisclosure;

        if (p.payee.key != PassportClaims.payeeKey(relyingParty) || p.payee.value != PassportClaims.ALLOWED) {
            return Reason.PayeeNotAllowed;
        }
        if (!_proves(root, p.payee)) return Reason.BadDisclosure;
        return Reason.Ok;
    }

    function _proves(bytes32 root, Disclosure calldata d) private pure returns (bool) {
        return MerkleProof.verifyCalldata(d.proof, root, PassportClaims.leaf(d.salt, d.key, d.value));
    }

    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _statusReason(CredentialStatusRegistry.Status s) private pure returns (Reason) {
        if (s == CredentialStatusRegistry.Status.Revoked) return Reason.Revoked;
        if (s == CredentialStatusRegistry.Status.Expired) return Reason.Expired;
        if (s == CredentialStatusRegistry.Status.NotYetValid) return Reason.NotYetValid;
        if (s == CredentialStatusRegistry.Status.Superseded) return Reason.Superseded;
        if (s == CredentialStatusRegistry.Status.IssuerNotOwner) return Reason.IssuerNotOwner;
        return Reason.UnknownCredential;
    }
}
