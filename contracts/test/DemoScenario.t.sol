// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PassportGate} from "../src/PassportGate.sol";
import {PassportGuarded} from "../src/PassportGuarded.sol";
import {GroundedFeedback} from "../src/GroundedFeedback.sol";
import {AgentReputationRegistry} from "../src/AgentReputationRegistry.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";
import {IAgentReputation} from "../src/interfaces/IAgentReputation.sol";
import {MockToken} from "../src/demo/MockToken.sol";
import {PassportDex} from "../src/demo/PassportDex.sol";
import {PassportMerchant} from "../src/demo/PassportMerchant.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

/// @notice The demo storyline, end to end: within limit → passes; over limit → rejected;
///         prompt-injected payee → rejected; owner revokes → the very next action is rejected.
contract DemoScenarioTest is PassportFixture {
    MockToken internal usdc;
    MockToken internal wmon;
    AgentReputationRegistry internal reputation;
    GroundedFeedback internal feedback;
    PassportDex internal dex;
    PassportMerchant internal merchant;

    bytes32 internal constant CID = keccak256("vc-demo");
    address internal treasury = makeAddr("merchant-treasury");

    function setUp() public {
        _deployCore();
        usdc = new MockToken("Mock USD", "mUSD", 6);
        wmon = new MockToken("Mock Wrapped MON", "mWMON", 18);
        reputation = new AgentReputationRegistry(IAgentIdentity(address(identity)));
        feedback = new GroundedFeedback(gate, IAgentReputation(address(reputation)));
        // 1 mUSD (1e6) -> 0.5 mWMON (5e17): rate = 5e17 * 1e18 / 1e6
        dex = new PassportDex(gate, usdc, wmon, 5e29, feedback);
        merchant = new PassportMerchant(gate, treasury);

        wmon.mint(address(dex), 1_000_000e18);
        usdc.mint(owner, 10_000e6);
        vm.prank(owner);
        usdc.approve(address(gate), type(uint256).max);

        _defaultClaims(address(usdc), 100e6, 250e6, address(dex));
        _anchor(CID);
    }

    function _swapIntent(uint256 amount, uint256 nonce) internal view returns (PassportGate.ActionIntent memory) {
        return PassportGate.ActionIntent(CID, SWAP, address(usdc), amount, address(dex), nonce, block.timestamp + 60);
    }

    function _swap(uint256 amount, uint256 nonce) internal returns (uint256) {
        PassportGate.ActionIntent memory i = _swapIntent(amount, nonce);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(agentWallet);
        return dex.swap(i, p, sig, 0);
    }

    function _expectRejected(PassportGate.Reason r) internal {
        vm.expectRevert(abi.encodeWithSelector(PassportGate.NotAuthorized.selector, r));
    }

    function test_story_withinLimit_overLimit_revoke() public {
        // 1. Within limit: settles, owner pays and receives, agent holds nothing.
        uint256 out = _swap(80e6, 1);
        assertEq(out, 40e18);
        assertEq(wmon.balanceOf(owner), 40e18);
        assertEq(usdc.balanceOf(owner), 9_920e6);
        assertEq(usdc.balanceOf(agentWallet) + wmon.balanceOf(agentWallet), 0);

        // 2. Over the per-tx limit: rejected on-chain.
        PassportGate.ActionIntent memory big = _swapIntent(150e6, 2);
        bytes memory sig = _signIntent(agentKey, big);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(agentWallet);
        _expectRejected(PassportGate.Reason.ExceedsPerTxLimit);
        dex.swap(big, p, sig, 0);

        // 3. Owner revokes; the very next action is rejected.
        vm.prank(owner);
        status.revoke(CID, "owner-revoked");
        PassportGate.ActionIntent memory next = _swapIntent(10e6, 3);
        sig = _signIntent(agentKey, next);
        vm.prank(agentWallet);
        _expectRejected(PassportGate.Reason.Revoked);
        dex.swap(next, p, sig, 0);
    }

    function test_settledSwapsBuildGroundedReputation() public {
        _swap(10e6, 1);
        _swap(10e6, 2);
        address[] memory clients = new address[](1);
        clients[0] = address(feedback);
        (uint64 count, int128 avg,) = reputation.getSummary(agentId, clients, "grounded-action", "");
        assertEq(count, 2);
        assertEq(avg, 100e18);
    }

    /// Prompt injection: the agent is talked into routing funds through a look-alike contract.
    /// It holds no funds itself, and the look-alike is not an allowed payee in the credential.
    function test_promptInjection_lookalikeDexRejected() public {
        PassportDex evil = new PassportDex(gate, usdc, wmon, 5e29, GroundedFeedback(address(0)));
        PassportGate.ActionIntent memory i =
            PassportGate.ActionIntent(CID, SWAP, address(usdc), 50e6, address(evil), 1, block.timestamp + 60);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(agentWallet);
        _expectRejected(PassportGate.Reason.PayeeNotAllowed);
        evil.swap(i, p, sig, 0);
        assertEq(usdc.balanceOf(owner), 10_000e6);
    }

    function test_revert_callerIsNotAgent() public {
        PassportGate.ActionIntent memory i = _swapIntent(1e6, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PassportGuarded.CallerIsNotAgent.selector, relayer, agentWallet));
        dex.swap(i, p, sig, 0);
    }

    function test_revert_dexWrongScopeAndSlippage() public {
        PassportGate.ActionIntent memory i = _swapIntent(1e6, 1);
        i.scope = LEND;
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(agentWallet);
        vm.expectRevert(PassportDex.WrongScope.selector);
        dex.swap(i, p, sig, 0);

        i = _swapIntent(1e6, 2);
        sig = _signIntent(agentKey, i);
        vm.prank(agentWallet);
        vm.expectRevert(PassportDex.Slippage.selector);
        dex.swap(i, p, sig, 1e30);
    }

    // ------------------------------------------------------------------ merchant (owner assurance)

    function _merchantCredential() internal returns (bytes32 cid) {
        cid = keccak256("vc-merchant");
        delete claims;
        claims.push(Claim(keccak256("m0"), keccak256("agentpassport:scope"), keccak256("commerce.pay")));
        claims.push(Claim(keccak256("m1"), _maxKey(), bytes32(uint256(20e6))));
        claims.push(Claim(keccak256("m2"), _dailyKey(), bytes32(uint256(50e6))));
        claims.push(Claim(keccak256("m3"), _payeeKey(address(merchant)), bytes32(uint256(1))));
        bytes32 root = _root();
        vm.prank(owner);
        status.anchor(cid, agentId, root, uint64(block.timestamp), uint64(block.timestamp + 1 days));
    }

    function _maxKey() internal view returns (bytes32) {
        return keccak256(abi.encode("agentpassport:maxPerTx", address(usdc)));
    }

    function _dailyKey() internal view returns (bytes32) {
        return keccak256(abi.encode("agentpassport:dailyLimit", address(usdc)));
    }

    function _payeeKey(address rp) internal pure returns (bytes32) {
        return keccak256(abi.encode("agentpassport:payee", rp));
    }

    function _pay(bytes32 cid, bytes32 orderId, uint256 nonce) internal {
        _pay(cid, orderId, nonce, "");
    }

    /// `expectedRevert` (if non-empty) is armed right before the merchant call, after the helper's
    /// own external calls, so it is not consumed by them.
    function _pay(bytes32 cid, bytes32 orderId, uint256 nonce, bytes memory expectedRevert) internal {
        PassportGate.ActionIntent memory i = PassportGate.ActionIntent(
            cid, keccak256("commerce.pay"), address(usdc), 5e6, address(merchant), nonce, block.timestamp + 60
        );
        PassportGate.Presentation memory p;
        p.credentialId = cid;
        p.scope = _disclose(0);
        p.maxPerTx = _disclose(1);
        p.dailyLimit = _disclose(2);
        p.payee = _disclose(3);
        bytes memory sig = _signIntent(agentKey, i);
        vm.prank(agentWallet);
        if (expectedRevert.length != 0) vm.expectRevert(expectedRevert);
        merchant.pay(orderId, i, p, sig);
    }

    function test_merchant_requiresVerifiedOwner() public {
        bytes32 cid = _merchantCredential();
        _pay(
            cid,
            "order-1",
            1,
            abi.encodeWithSelector(PassportGate.NotAuthorized.selector, PassportGate.Reason.OwnerNotVleiVerified)
        );

        _markVleiVerified(cid);

        _pay(cid, "order-1", 2);
        assertEq(usdc.balanceOf(treasury), 5e6);

        _pay(cid, "order-1", 3, abi.encodeWithSelector(PassportMerchant.OrderAlreadyPaid.selector));
    }

    // ------------------------------------------------------------------ grounded feedback

    function test_groundedFeedback_reverts() public {
        vm.expectRevert(GroundedFeedback.UnknownAction.selector);
        feedback.rate(keccak256("made-up"), 100, 0, "", "");

        // The DEX already rated this action inside swap().
        PassportGate.ActionIntent memory i = _swapIntent(1e6, 1);
        bytes32 actionId = gate.hashIntent(i);
        _swap(1e6, 1);
        assertTrue(feedback.rated(actionId));

        vm.expectRevert(GroundedFeedback.NotCounterparty.selector);
        feedback.rate(actionId, 1, 0, "", "");
        vm.prank(address(dex));
        vm.expectRevert(GroundedFeedback.AlreadyRated.selector);
        feedback.rate(actionId, 1, 0, "", "");
    }
}
