// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";

/// @title AgentReputationRegistry
/// @notice Minimal ERC-8004 Reputation Registry: clients leave signed-by-transaction feedback on agents,
///         can revoke it, and agents (or anyone) can append responses.
/// @dev Function and event signatures follow ERC-8004 (Draft, 2026-01-25). `getSummary` requires an
///      explicit client list, as the spec does, so Sybil feedback cannot dilute a curated view.
contract AgentReputationRegistry {
    using SafeCast for int256;

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        string tag1;
        string tag2;
    }

    int128 public constant MAX_ABS_VALUE = 1e38;
    uint8 public constant SUMMARY_DECIMALS = 18;

    IAgentIdentity public immutable identityRegistry;

    mapping(uint256 agentId => mapping(address client => mapping(uint64 index => Feedback))) private _feedback;
    mapping(uint256 agentId => mapping(address client => uint64)) private _lastIndex;
    mapping(uint256 agentId => address[]) private _clients;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    error SelfFeedback();
    error TooManyDecimals();
    error ValueOutOfRange();
    error UnknownFeedback();
    error AlreadyRevoked();
    error EmptyURI();
    error ClientListRequired();

    constructor(IAgentIdentity identityRegistry_) {
        identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identityRegistry);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (valueDecimals > SUMMARY_DECIMALS) revert TooManyDecimals();
        if (value > MAX_ABS_VALUE || value < -MAX_ABS_VALUE) revert ValueOutOfRange();
        // Also reverts for unknown agents. An agent's own principal cannot rate it.
        if (identityRegistry.isAuthorizedOrOwner(msg.sender, agentId)) revert SelfFeedback();

        uint64 index = ++_lastIndex[agentId][msg.sender];
        if (index == 1) _clients[agentId].push(msg.sender);
        _feedback[agentId][msg.sender][index] = Feedback(value, valueDecimals, false, tag1, tag2);

        emit NewFeedback(
            agentId, msg.sender, index, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][msg.sender]) revert UnknownFeedback();
        Feedback storage f = _feedback[agentId][msg.sender][feedbackIndex];
        if (f.isRevoked) revert AlreadyRevoked();
        f.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert UnknownFeedback();
        if (bytes(responseURI).length == 0) revert EmptyURI();
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert UnknownFeedback();
        Feedback storage f = _feedback[agentId][clientAddress][feedbackIndex];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    /// @notice Mean of non-revoked feedback from `clientAddresses`, optionally filtered by tags
    ///         (empty string = any), normalised to 18 decimals.
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        if (clientAddresses.length == 0) revert ClientListRequired();
        bytes32 t1 = keccak256(bytes(tag1));
        bytes32 t2 = keccak256(bytes(tag2));
        bool any1 = bytes(tag1).length == 0;
        bool any2 = bytes(tag2).length == 0;

        int256 sum = 0;
        for (uint256 c; c < clientAddresses.length; ++c) {
            address client = clientAddresses[c];
            uint64 last = _lastIndex[agentId][client];
            for (uint64 i = 1; i <= last; ++i) {
                Feedback storage f = _feedback[agentId][client][i];
                if (f.isRevoked) continue;
                if (!any1 && keccak256(bytes(f.tag1)) != t1) continue;
                if (!any2 && keccak256(bytes(f.tag2)) != t2) continue;
                sum += int256(f.value) * int256(10 ** (SUMMARY_DECIMALS - f.valueDecimals));
                ++count;
            }
        }
        if (count != 0) summaryValue = (sum / int256(uint256(count))).toInt128();
        summaryValueDecimals = SUMMARY_DECIMALS;
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _lastIndex[agentId][clientAddress];
    }
}
