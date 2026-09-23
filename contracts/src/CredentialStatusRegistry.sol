// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";

/// @title CredentialStatusRegistry
/// @notice On-chain status list for agent authorization credentials ("passport visas").
///
///         The owner of an ERC-8004 agent issues an off-chain W3C VC to that agent. Only two things
///         about it go on-chain:
///           - `credentialId`: the hash of the signed VC, so anyone holding the VC can look it up;
///           - `disclosureRoot`: the Merkle root over the VC's salted claim digests, which lets a
///             verifier check individual disclosed claims without seeing the rest (see PassportGate).
///         Everything else — who the owner is off-chain, the purpose, other limits — stays private.
///
///         A credential stops being valid when any of these happen, checked on every read:
///           revoked by its issuer · outside [validFrom, validUntil) · the agent's credential epoch was
///           bumped ("revoke everything now") · the agent NFT changed hands after issuance.
///
///         Owner assurance: who stands behind the agent. A registered vLEI verifier (an off-chain
///         service that checks the GLEIF vLEI chain — legal-entity vLEI → role credential (OOR/ECR) →
///         the role holder signed this credential) records the *result* here, together with the hash
///         of the role credential's SAID. KERI/ACDC verification itself stays off-chain.
contract CredentialStatusRegistry is Ownable {
    enum Status {
        Unknown,
        Active,
        NotYetValid,
        Expired,
        Revoked,
        Superseded,
        IssuerNotOwner
    }

    enum OwnerAssurance {
        NONE,
        VLEI_VERIFIED
    }

    struct Credential {
        uint256 agentId;
        address issuer;
        bytes32 disclosureRoot;
        uint64 validFrom;
        uint64 validUntil;
        uint64 epoch;
        uint64 revokedAt;
        OwnerAssurance ownerAssurance;
        bytes32 vleiSaidHash;
        address assuredBy;
    }

    IAgentIdentity public immutable identityRegistry;

    mapping(bytes32 credentialId => Credential) private _credentials;
    mapping(uint256 agentId => uint64) public agentEpoch;
    mapping(address verifier => bool) public isVleiVerifier;

    event CredentialAnchored(
        bytes32 indexed credentialId,
        uint256 indexed agentId,
        address indexed issuer,
        bytes32 disclosureRoot,
        uint64 validFrom,
        uint64 validUntil,
        uint64 epoch
    );
    event CredentialRevoked(bytes32 indexed credentialId, uint256 indexed agentId, address indexed by, bytes32 reason);
    event AgentCredentialsReset(uint256 indexed agentId, uint64 newEpoch, address indexed by);
    event OwnerAssuranceRecorded(
        bytes32 indexed credentialId, OwnerAssurance assurance, bytes32 vleiSaidHash, address indexed verifier
    );
    event VleiVerifierSet(address indexed verifier, bool enabled);

    error ZeroCredentialId();
    error ZeroRoot();
    error AlreadyAnchored();
    error BadValidityWindow();
    error NotAgentOwner();
    error UnknownCredential();
    error AlreadyRevoked();
    error NotIssuer();
    error NotVleiVerifier();
    error ZeroSaid();

    constructor(IAgentIdentity identityRegistry_, address admin) Ownable(admin) {
        identityRegistry = identityRegistry_;
    }

    // ------------------------------------------------------------------ vLEI owner assurance

    function setVleiVerifier(address verifier, bool enabled) external onlyOwner {
        isVleiVerifier[verifier] = enabled;
        emit VleiVerifierSet(verifier, enabled);
    }

    /// @notice Record the outcome of an off-chain vLEI check for `credentialId`'s issuer.
    ///         `vleiSaidHash` = keccak256 of the role credential's SAID (the SAID itself stays off-chain).
    ///         Pass NONE to withdraw an earlier result (e.g. the role credential was revoked in KERI).
    function recordOwnerAssurance(bytes32 credentialId, OwnerAssurance assurance, bytes32 vleiSaidHash) external {
        if (!isVleiVerifier[msg.sender]) revert NotVleiVerifier();
        Credential storage c = _credentials[credentialId];
        if (c.issuer == address(0)) revert UnknownCredential();
        if (assurance == OwnerAssurance.VLEI_VERIFIED && vleiSaidHash == bytes32(0)) revert ZeroSaid();

        c.ownerAssurance = assurance;
        c.vleiSaidHash = assurance == OwnerAssurance.NONE ? bytes32(0) : vleiSaidHash;
        c.assuredBy = msg.sender;
        emit OwnerAssuranceRecorded(credentialId, assurance, c.vleiSaidHash, msg.sender);
    }

    /// @notice Current assurance; a result from a verifier that has since been removed no longer counts.
    function ownerAssuranceOf(bytes32 credentialId) public view returns (OwnerAssurance) {
        Credential storage c = _credentials[credentialId];
        if (c.ownerAssurance == OwnerAssurance.NONE || !isVleiVerifier[c.assuredBy]) return OwnerAssurance.NONE;
        return c.ownerAssurance;
    }

    // ------------------------------------------------------------------ writes

    /// @notice Anchor a credential the caller (the agent's owner) has issued to `agentId`.
    function anchor(
        bytes32 credentialId,
        uint256 agentId,
        bytes32 disclosureRoot,
        uint64 validFrom,
        uint64 validUntil
    ) external {
        if (credentialId == bytes32(0)) revert ZeroCredentialId();
        if (disclosureRoot == bytes32(0)) revert ZeroRoot();
        if (_credentials[credentialId].issuer != address(0)) revert AlreadyAnchored();
        if (validUntil <= validFrom || validUntil <= block.timestamp) revert BadValidityWindow();
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        uint64 epoch = agentEpoch[agentId];
        _credentials[credentialId] = Credential({
            agentId: agentId,
            issuer: msg.sender,
            disclosureRoot: disclosureRoot,
            validFrom: validFrom,
            validUntil: validUntil,
            epoch: epoch,
            revokedAt: 0,
            ownerAssurance: OwnerAssurance.NONE,
            vleiSaidHash: bytes32(0),
            assuredBy: address(0)
        });
        emit CredentialAnchored(credentialId, agentId, msg.sender, disclosureRoot, validFrom, validUntil, epoch);
    }

    /// @notice Revoke one credential. Only its issuer may. (A new owner of a transferred agent does not
    ///         need to: the transfer already invalidates it, and `revokeAll` is available as well.)
    function revoke(bytes32 credentialId, bytes32 reason) external {
        Credential storage c = _credentials[credentialId];
        if (c.issuer == address(0)) revert UnknownCredential();
        if (c.revokedAt != 0) revert AlreadyRevoked();
        if (msg.sender != c.issuer) revert NotIssuer();

        c.revokedAt = uint64(block.timestamp);
        emit CredentialRevoked(credentialId, c.agentId, msg.sender, reason);
    }

    /// @notice Kill switch: invalidate every credential issued to `agentId` so far, in one transaction.
    function revokeAll(uint256 agentId) external {
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        uint64 newEpoch = ++agentEpoch[agentId];
        emit AgentCredentialsReset(agentId, newEpoch, msg.sender);
    }

    // ------------------------------------------------------------------ reads

    function getCredential(bytes32 credentialId) external view returns (Credential memory) {
        return _credentials[credentialId];
    }

    function statusOf(bytes32 credentialId) public view returns (Status) {
        Credential storage c = _credentials[credentialId];
        if (c.issuer == address(0)) return Status.Unknown;
        if (c.revokedAt != 0) return Status.Revoked;
        if (c.epoch != agentEpoch[c.agentId]) return Status.Superseded;
        if (_currentOwner(c.agentId) != c.issuer) return Status.IssuerNotOwner;
        if (block.timestamp < c.validFrom) return Status.NotYetValid;
        if (block.timestamp >= c.validUntil) return Status.Expired;
        return Status.Active;
    }

    function isActive(bytes32 credentialId) external view returns (bool) {
        return statusOf(credentialId) == Status.Active;
    }

    /// @dev Burned or unknown agents have no owner; treat as address(0) instead of reverting.
    function _currentOwner(uint256 agentId) private view returns (address) {
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }
}
