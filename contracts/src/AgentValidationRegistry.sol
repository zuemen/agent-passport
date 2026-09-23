// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";

/// @title AgentValidationRegistry
/// @notice Minimal ERC-8004 Validation Registry: an agent's principal asks a named validator to check
///         some work (identified by `requestHash`); only that validator can answer, with a 0–100 score.
/// @dev Signatures follow ERC-8004 (Draft, 2026-01-25). The spec marks this registry as still under
///      discussion, and there is no official Monad deployment of it, so we ship our own.
contract AgentValidationRegistry {
    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bool hasResponse;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
    }

    IAgentIdentity public immutable identityRegistry;

    mapping(bytes32 requestHash => ValidationStatus) private _validations;
    mapping(uint256 agentId => bytes32[]) private _agentValidations;
    mapping(address validator => bytes32[]) private _validatorRequests;

    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    error ZeroValidator();
    error RequestExists();
    error NotAgentOperator();
    error UnknownRequest();
    error NotValidator();
    error ResponseOutOfRange();

    constructor(IAgentIdentity identityRegistry_) {
        identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        if (validatorAddress == address(0)) revert ZeroValidator();
        if (_validations[requestHash].validatorAddress != address(0)) revert RequestExists();
        if (!identityRegistry.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAgentOperator();

        ValidationStatus storage s = _validations[requestHash];
        s.validatorAddress = validatorAddress;
        s.agentId = agentId;
        s.lastUpdate = block.timestamp;
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    /// @notice May be called repeatedly (e.g. soft then hard finality); the latest answer wins.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest();
        if (msg.sender != s.validatorAddress) revert NotValidator();
        if (response > 100) revert ResponseOutOfRange();

        s.response = response;
        s.hasResponse = true;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;

        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest();
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    /// @notice Average of answered requests for `agentId`, optionally restricted to `validatorAddresses`
    ///         (empty = all) and `tag` (empty = any).
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32 tagHash = keccak256(bytes(tag));
        bool anyTag = bytes(tag).length == 0;
        uint256 total;
        bytes32[] storage hashes = _agentValidations[agentId];
        for (uint256 i; i < hashes.length; ++i) {
            ValidationStatus storage s = _validations[hashes[i]];
            if (!s.hasResponse) continue;
            if (!anyTag && keccak256(bytes(s.tag)) != tagHash) continue;
            if (validatorAddresses.length != 0 && !_contains(validatorAddresses, s.validatorAddress)) continue;
            total += s.response;
            ++count;
        }
        // forge-lint: disable-next-line(unsafe-typecast) -- mean of values each <= 100
        if (count != 0) avgResponse = uint8(total / count);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function _contains(address[] calldata list, address who) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == who) return true;
        }
        return false;
    }
}
