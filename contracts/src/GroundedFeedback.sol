// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentReputation} from "./interfaces/IAgentReputation.sol";
import {PassportGate} from "./PassportGate.sol";

/// @title GroundedFeedback
/// @notice ERC-8004 feedback grounded in real actions: the only way to post feedback through this
///         contract is to be the counterparty of an action PassportGate actually authorized, and each
///         action can be rated once. The feedback lands in a standard ERC-8004 Reputation Registry
///         (ours or the official deployment) with this contract as the client and the action id as
///         `feedbackHash`, so anyone can read a score grounded in authorized actions with
///             getSummary(agentId, [address(groundedFeedback)], "grounded-action", "")
///         and trace every entry back to its on-chain action. Not Sybil-proof: the gate accepts
///         zero-amount actions, and the registry itself also takes direct feedback (docs/SECURITY.md).
/// @dev Motivation: an empirical study of deployed ERC-8004 registries found feedback "rarely grounded
///      in verifiable interactions" and cheap to manipulate (arXiv 2606.26028).
contract GroundedFeedback {
    string public constant TAG = "grounded-action";

    PassportGate public immutable gate;
    IAgentReputation public immutable reputation;

    mapping(bytes32 actionId => bool) public rated;

    event ActionRated(bytes32 indexed actionId, uint256 indexed agentId, address indexed rater, int128 value);

    error UnknownAction();
    error NotCounterparty();
    error AlreadyRated();

    constructor(PassportGate gate_, IAgentReputation reputation_) {
        gate = gate_;
        reputation = reputation_;
    }

    /// @notice Rate the agent behind `actionId`. Only that action's relying party may call.
    function rate(bytes32 actionId, int128 value, uint8 valueDecimals, string calldata tag2, string calldata feedbackURI)
        external
    {
        PassportGate.Action memory a = gate.getAction(actionId);
        if (a.relyingParty == address(0)) revert UnknownAction();
        if (a.relyingParty != msg.sender) revert NotCounterparty();
        if (rated[actionId]) revert AlreadyRated();

        rated[actionId] = true;
        emit ActionRated(actionId, a.agentId, msg.sender, value);

        reputation.giveFeedback(a.agentId, value, valueDecimals, TAG, tag2, "", feedbackURI, actionId);
    }
}
