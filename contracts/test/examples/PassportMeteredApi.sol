// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PassportGate} from "../../src/PassportGate.sol";
import {PassportGuarded} from "../../src/PassportGuarded.sol";

/// @title PassportMeteredApi (integration example — not deployed)
/// @notice The check-only style (`_requirePassport`): a pay-per-call API that bills the agent's own wallet,
///         but only for calls the agent's owner authorized — the "api.call" scope, per-call and daily limits,
///         and this API as an allowed counterparty. The gate still books each call against the daily limit.
contract PassportMeteredApi is PassportGuarded, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CALL_SCOPE = keccak256("api.call");
    address public immutable treasury;
    mapping(bytes32 actionId => bytes32 requestHash) public paidRequests;

    event CallPaid(bytes32 indexed actionId, uint256 indexed agentId, bytes32 requestHash, uint256 price);

    error WrongScope();

    constructor(PassportGate gate, address treasury_) PassportGuarded(gate) {
        treasury = treasury_;
    }

    /// @notice Pay `intent.amount` of `intent.asset` from the calling agent's wallet for one request.
    function payForCall(
        bytes32 requestHash,
        PassportGate.ActionIntent calldata intent,
        PassportGate.Presentation calldata presentation,
        bytes calldata agentSignature
    ) external nonReentrant returns (bytes32 actionId) {
        if (intent.scope != CALL_SCOPE) revert WrongScope();
        uint256 agentId;
        (actionId, agentId) = _requirePassport(intent, presentation, agentSignature);
        paidRequests[actionId] = requestHash;
        emit CallPaid(actionId, agentId, requestHash, intent.amount);
        IERC20(intent.asset).safeTransferFrom(msg.sender, treasury, intent.amount);
    }
}
