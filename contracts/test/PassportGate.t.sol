// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PassportGate} from "../src/PassportGate.sol";
import {PassportClaims} from "../src/libraries/PassportClaims.sol";
import {CredentialStatusRegistry} from "../src/CredentialStatusRegistry.sol";
import {MockToken} from "../src/demo/MockToken.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

/// @dev This test contract plays the relying party (it calls `authorize` itself).
contract PassportGateTest is PassportFixture {
    MockToken internal usdc;
    bytes32 internal constant CID = keccak256("vc-1");
    uint256 internal constant MAX = 100e6;
    uint256 internal constant DAILY = 250e6;

    function setUp() public {
        _deployCore();
        usdc = new MockToken("Mock USD", "mUSD", 6);
        _defaultClaims(address(usdc), MAX, DAILY, address(this));
        _anchor(CID);
    }

    // ------------------------------------------------------------------ helpers

    function _intent(uint256 amount, uint256 nonce) internal view returns (PassportGate.ActionIntent memory) {
        return PassportGate.ActionIntent(CID, SWAP, address(usdc), amount, address(this), nonce, block.timestamp + 60);
    }

    function _authorize(uint256 amount, uint256 nonce) internal returns (bytes32 actionId) {
        PassportGate.ActionIntent memory i = _intent(amount, nonce);
        (actionId,,) = gate.authorize(i, _presentation(CID), _signIntent(agentKey, i));
    }

    function _expectNotAuthorized(PassportGate.Reason r) internal {
        vm.expectRevert(abi.encodeWithSelector(PassportGate.NotAuthorized.selector, r));
    }

    function _check(uint256 amount) internal view returns (PassportGate.Reason) {
        return gate.check(agentId, SWAP, address(usdc), amount, address(this), _presentation(CID));
    }

    function _eq(PassportGate.Reason a, PassportGate.Reason b) internal pure {
        assertEq(uint8(a), uint8(b));
    }

    // ------------------------------------------------------------------ happy paths

    function test_check_ok() public view {
        _eq(_check(MAX), PassportGate.Reason.Ok);
        assertTrue(gate.isAuthorized(agentId, SWAP, address(usdc), MAX, address(this), _presentation(CID)));
    }

    function test_authorize_recordsActionAndSpend() public {
        PassportGate.ActionIntent memory i = _intent(40e6, 1);
        bytes32 expectedId = gate.hashIntent(i);
        vm.expectEmit(true, true, true, true);
        emit PassportGate.AgentActionAuthorized(expectedId, agentId, address(this), CID, agentWallet, SWAP, address(usdc), 40e6);
        (bytes32 actionId, uint256 id, address wallet) = gate.authorize(i, _presentation(CID), _signIntent(agentKey, i));

        assertEq(actionId, expectedId);
        assertEq(id, agentId);
        assertEq(wallet, agentWallet);
        assertEq(gate.spentToday(CID, address(usdc)), 40e6);
        PassportGate.Action memory a = gate.getAction(actionId);
        assertEq(a.agentId, agentId);
        assertEq(a.relyingParty, address(this));
        assertTrue(gate.nonceUsed(agentWallet, 1));
    }

    function test_authorizeAndPull_movesFundsFromOwnerNotAgent() public {
        usdc.mint(owner, 1_000e6);
        vm.prank(owner);
        usdc.approve(address(gate), type(uint256).max);

        PassportGate.ActionIntent memory i = _intent(60e6, 1);
        (,,, address payer) = gate.authorizeAndPull(i, _presentation(CID), _signIntent(agentKey, i));

        assertEq(payer, owner);
        assertEq(usdc.balanceOf(address(this)), 60e6);
        assertEq(usdc.balanceOf(owner), 940e6);
        assertEq(usdc.balanceOf(agentWallet), 0, "agent never custodies funds");
    }

    function test_unorderedNonces_allowParallelActions() public {
        _authorize(10e6, 9);
        _authorize(10e6, 2);
        _authorize(10e6, 777);
        assertEq(gate.spentToday(CID, address(usdc)), 30e6);
    }

    // ------------------------------------------------------------------ limits

    function test_revert_exceedsPerTx() public {
        _eq(_check(MAX + 1), PassportGate.Reason.ExceedsPerTxLimit);
        PassportGate.ActionIntent memory i = _intent(MAX + 1, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        _expectNotAuthorized(PassportGate.Reason.ExceedsPerTxLimit);
        gate.authorize(i, p, sig);
    }

    function test_revert_exceedsDaily_thenResetsNextDay() public {
        _authorize(100e6, 1);
        _authorize(100e6, 2);
        _eq(_check(60e6), PassportGate.Reason.ExceedsDailyLimit);

        PassportGate.ActionIntent memory i = _intent(60e6, 3);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        _expectNotAuthorized(PassportGate.Reason.ExceedsDailyLimit);
        gate.authorize(i, p, sig);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        _eq(_check(60e6), PassportGate.Reason.Ok);
    }

    function testFuzz_perTxLimit(uint256 amount) public view {
        amount = bound(amount, 0, 10 * MAX);
        PassportGate.Reason r = _check(amount);
        if (amount <= MAX) _eq(r, PassportGate.Reason.Ok);
        else _eq(r, PassportGate.Reason.ExceedsPerTxLimit);
    }

    // ------------------------------------------------------------------ credential status

    function test_revert_revoked_nextActionRejected() public {
        _authorize(10e6, 1);
        vm.prank(owner);
        status.revoke(CID, "compromised");

        _eq(_check(10e6), PassportGate.Reason.Revoked);
        PassportGate.ActionIntent memory i = _intent(10e6, 2);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        _expectNotAuthorized(PassportGate.Reason.Revoked);
        gate.authorize(i, p, sig);
    }

    function test_revert_killSwitch_superseded() public {
        vm.prank(owner);
        status.revokeAll(agentId);
        _eq(_check(1), PassportGate.Reason.Superseded);
    }

    function test_check_expiredAndNotYetValid() public {
        bytes32 later = keccak256("vc-later");
        vm.prank(owner);
        status.anchor(later, agentId, _root(), uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours));
        _eq(
            gate.check(agentId, SWAP, address(usdc), 1, address(this), _presentation(later)),
            PassportGate.Reason.NotYetValid
        );
        vm.warp(vm.getBlockTimestamp() + 31 days);
        _eq(_check(1), PassportGate.Reason.Expired);
    }

    function test_check_agentTransferred() public {
        vm.prank(owner);
        identity.transferFrom(owner, makeAddr("buyer"), agentId);
        _eq(_check(1), PassportGate.Reason.IssuerNotOwner);
    }

    function test_check_unknownCredential() public view {
        _eq(
            gate.check(agentId, SWAP, address(usdc), 1, address(this), _presentation(keccak256("nope"))),
            PassportGate.Reason.UnknownCredential
        );
    }

    function test_revert_authorize_unknownCredential() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        i.credentialId = keccak256("nope");
        PassportGate.Presentation memory p = _presentation(keccak256("nope"));
        bytes memory sig = _signIntent(agentKey, i);
        _expectNotAuthorized(PassportGate.Reason.UnknownCredential);
        gate.authorize(i, p, sig);
    }

    // ------------------------------------------------------------------ disclosures

    function test_check_wrongAgent() public {
        _eq(
            gate.check(agentId + 1, SWAP, address(usdc), 1, address(this), _presentation(CID)),
            PassportGate.Reason.WrongAgent
        );
    }

    function test_check_tamperedDisclosure() public view {
        PassportGate.Presentation memory p = _presentation(CID);
        p.maxPerTx.value = bytes32(uint256(1_000_000e6)); // agent tries to raise its own limit
        _eq(gate.check(agentId, SWAP, address(usdc), 1, address(this), p), PassportGate.Reason.BadDisclosure);

        p = _presentation(CID);
        p.scope.salt = bytes32(0);
        _eq(gate.check(agentId, SWAP, address(usdc), 1, address(this), p), PassportGate.Reason.BadDisclosure);
    }

    function test_check_scopeNotGranted() public view {
        _eq(
            gate.check(agentId, keccak256("bridge.withdraw"), address(usdc), 1, address(this), _presentation(CID)),
            PassportGate.Reason.ScopeNotGranted
        );
    }

    function test_check_assetNotGranted() public {
        _eq(
            gate.check(agentId, SWAP, makeAddr("otherToken"), 1, address(this), _presentation(CID)),
            PassportGate.Reason.AssetNotGranted
        );
    }

    /// Prompt-injection shape: the agent is steered to an attacker's contract. Even with a valid
    /// credential and signature, that contract is not an allowed payee.
    function test_revert_payeeNotAllowed() public {
        address attacker = makeAddr("attacker-dex");
        _eq(
            gate.check(agentId, SWAP, address(usdc), 1, attacker, _presentation(CID)),
            PassportGate.Reason.PayeeNotAllowed
        );
        PassportGate.ActionIntent memory i = _intent(1, 1);
        i.relyingParty = attacker;
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(attacker);
        _expectNotAuthorized(PassportGate.Reason.PayeeNotAllowed);
        gate.authorize(i, p, sig);
    }

    // ------------------------------------------------------------------ key binding & replay

    function test_revert_wrongRelyingParty() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(makeAddr("front-runner"));
        vm.expectRevert(PassportGate.WrongRelyingParty.selector);
        gate.authorize(i, p, sig);
    }

    function test_revert_intentExpired() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        i.deadline = block.timestamp - 1;
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.expectRevert(PassportGate.IntentExpired.selector);
        gate.authorize(i, p, sig);
    }

    function test_revert_credentialMismatch() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        i.credentialId = keccak256("other");
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.expectRevert(PassportGate.CredentialMismatch.selector);
        gate.authorize(i, p, sig);
    }

    function test_revert_replay() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        gate.authorize(i, p, sig);
        vm.expectRevert(PassportGate.NonceAlreadyUsed.selector);
        gate.authorize(i, p, sig);
    }

    function test_revert_signatureFromWrongKey() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        bytes memory sig = _signIntent(0xBAD, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.expectRevert(PassportGate.InvalidAgentSignature.selector);
        gate.authorize(i, p, sig);
    }

    function test_revert_signatureForDifferentAmount() public {
        PassportGate.ActionIntent memory i = _intent(1, 1);
        bytes memory sig = _signIntent(agentKey, i);
        i.amount = 99e6; // relying party inflates the amount after the agent signed
        PassportGate.Presentation memory p = _presentation(CID);
        vm.expectRevert(PassportGate.InvalidAgentSignature.selector);
        gate.authorize(i, p, sig);
    }

    // ------------------------------------------------------------------ vLEI requirement

    function test_vlei_requiredScope_rejectsUnverifiedOwner() public {
        gate.setVleiRequirement(SWAP, true);
        _eq(_check(1), PassportGate.Reason.OwnerNotVleiVerified);

        PassportGate.ActionIntent memory i = _intent(1, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        _expectNotAuthorized(PassportGate.Reason.OwnerNotVleiVerified);
        gate.authorize(i, p, sig);

        _markVleiVerified(CID);
        _eq(_check(1), PassportGate.Reason.Ok);
        gate.authorize(i, p, sig);
    }

    function test_vlei_requirementIsPerRelyingPartyAndScope() public {
        gate.setVleiRequirement(LEND, true); // only lending requires it here
        _eq(_check(1), PassportGate.Reason.Ok);
        vm.prank(makeAddr("other-rp"));
        gate.setVleiRequirement(SWAP, true); // another relying party's rule does not apply to us
        _eq(_check(1), PassportGate.Reason.Ok);
    }

    function test_vlei_removedVerifierNoLongerCounts() public {
        gate.setVleiRequirement(SWAP, true);
        _markVleiVerified(CID);
        _eq(_check(1), PassportGate.Reason.Ok);
        status.setVleiVerifier(vleiVerifier, false);
        _eq(_check(1), PassportGate.Reason.OwnerNotVleiVerified);
    }

    function test_claimKeysMatchSdkEncoding() public pure {
        // Pinned so the TypeScript SDK can assert the same values.
        assertEq(PassportClaims.KEY_SCOPE, keccak256("agentpassport:scope"));
        assertEq(
            PassportClaims.maxPerTxKey(address(0x1234)),
            keccak256(abi.encode("agentpassport:maxPerTx", address(0x1234)))
        );
    }
}
