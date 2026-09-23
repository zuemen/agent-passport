// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PassportGate} from "../PassportGate.sol";
import {PassportGuarded} from "../PassportGuarded.sol";

/// @title PassportMerchant
/// @notice Demo relying party #2: a merchant that sells to AI agents (think paid API calls or an
///         agentic checkout). Unlike the DEX it requires the agent's *owner* to be a vLEI-verified
///         legal entity — it learns that the owner is verified, not who the owner is. Payment is pulled
///         from the owner straight to the merchant treasury.
contract PassportMerchant is PassportGuarded, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAY_SCOPE = keccak256("commerce.pay");

    address public immutable treasury;
    mapping(bytes32 orderId => bytes32 actionId) public paidOrders;

    event OrderPaid(bytes32 indexed orderId, bytes32 indexed actionId, address indexed agentWallet, uint256 amount);

    error WrongScope();
    error OrderAlreadyPaid();
    error ZeroTreasury();

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
