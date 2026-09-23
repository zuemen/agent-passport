// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PassportGate} from "../PassportGate.sol";
import {PassportGuarded} from "../PassportGuarded.sol";
import {GroundedFeedback} from "../GroundedFeedback.sol";

/// @title PassportDex
/// @notice Demo relying party: a fixed-rate swap desk that only serves AI agents holding a valid
///         Agent Passport credential for the "dex.swap" scope. Not a real AMM — it exists to show a
///         protocol integrating PassportGate in a few lines. Funds come from, and return to, the
///         agent's owner; the agent wallet only pays gas. Every settled swap is rated through
///         GroundedFeedback, so the agent's reputation is built from real, authorized actions.
contract PassportDex is PassportGuarded, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SWAP_SCOPE = keccak256("dex.swap");

    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    /// tokenB base units paid per tokenA base unit, scaled by 1e18.
    uint256 public immutable rateAtoB;
    GroundedFeedback public immutable feedback;

    event Swapped(
        bytes32 indexed actionId,
        address indexed agentWallet,
        address indexed owner,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );
    event FeedbackSkipped(bytes32 indexed actionId);

    error UnsupportedPair();
    error WrongScope();
    error Slippage();

    constructor(PassportGate gate, IERC20 tokenA_, IERC20 tokenB_, uint256 rateAtoB_, GroundedFeedback feedback_)
        PassportGuarded(gate)
    {
        tokenA = tokenA_;
        tokenB = tokenB_;
        rateAtoB = rateAtoB_;
        feedback = feedback_;
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == address(tokenA)) return amountIn * rateAtoB / 1e18;
        if (tokenIn == address(tokenB)) return amountIn * 1e18 / rateAtoB;
        revert UnsupportedPair();
    }

    function swap(
        PassportGate.ActionIntent calldata intent,
        PassportGate.Presentation calldata presentation,
        bytes calldata agentSignature,
        uint256 minAmountOut
    ) external nonReentrant returns (uint256 amountOut) {
        if (intent.scope != SWAP_SCOPE) revert WrongScope();
        amountOut = quote(intent.asset, intent.amount);
        if (amountOut < minAmountOut) revert Slippage();
        IERC20 tokenOut = intent.asset == address(tokenA) ? tokenB : tokenA;

        (bytes32 actionId, address owner) = _pullWithPassport(intent, presentation, agentSignature);

        emit Swapped(actionId, msg.sender, owner, intent.asset, intent.amount, amountOut);
        tokenOut.safeTransfer(owner, amountOut);

        // Reputation is best-effort: a reputation-registry outage must not block settlement.
        if (address(feedback) != address(0)) {
            try feedback.rate(actionId, 100, 0, "settled", "") {}
            catch {
                emit FeedbackSkipped(actionId);
            }
        }
    }
}
