// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PassportGate} from "./PassportGate.sol";

/// @title PassportGuarded
/// @notice Base for protocols that accept AI agents. Two integration styles:
///           - `_requirePassport`: check-only; funds come from wherever the protocol normally takes
///             them (typically the agent wallet).
///           - `_pullWithPassport`: owner-funded; the gate moves the funds from the agent's owner to
///             this contract, so the agent wallet never custodies money.
///         Either way the transaction sender must be the agent wallet named by the credential.
abstract contract PassportGuarded {
    PassportGate public immutable passportGate;

    error CallerIsNotAgent(address caller, address agentWallet);

    constructor(PassportGate gate) {
        passportGate = gate;
    }

    function _requirePassport(
        PassportGate.ActionIntent calldata intent,
        PassportGate.Presentation calldata presentation,
        bytes calldata agentSignature
    ) internal returns (bytes32 actionId, uint256 agentId) {
        address agentWallet;
        (actionId, agentId, agentWallet) = passportGate.authorize(intent, presentation, agentSignature);
        if (agentWallet != msg.sender) revert CallerIsNotAgent(msg.sender, agentWallet);
    }

    /// @return actionId Id of the authorized action (for GroundedFeedback).
    /// @return payer    The agent's owner, whose funds were just transferred to this contract.
    function _pullWithPassport(
        PassportGate.ActionIntent calldata intent,
        PassportGate.Presentation calldata presentation,
        bytes calldata agentSignature
    ) internal returns (bytes32 actionId, address payer) {
        address agentWallet;
        (actionId,, agentWallet, payer) = passportGate.authorizeAndPull(intent, presentation, agentSignature);
        if (agentWallet != msg.sender) revert CallerIsNotAgent(msg.sender, agentWallet);
    }
}
