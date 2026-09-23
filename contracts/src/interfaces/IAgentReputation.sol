// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Write side of an ERC-8004 Reputation Registry (Draft, 2026-01-25). Satisfied by our
///         AgentReputationRegistry and by the official deployment on Monad testnet.
interface IAgentReputation {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
