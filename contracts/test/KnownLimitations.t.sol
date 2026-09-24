// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PassportGate} from "../src/PassportGate.sol";
import {GroundedFeedback} from "../src/GroundedFeedback.sol";
import {AgentReputationRegistry} from "../src/AgentReputationRegistry.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";
import {IAgentReputation} from "../src/interfaces/IAgentReputation.sol";
import {PassportClaims} from "../src/libraries/PassportClaims.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

/// @notice The limitations docs/SECURITY.md lists, pinned down as tests: each one passes because the limitation
///         is real. If a later version closes one, its test fails and the docs must change with it.
contract KnownLimitationsTest is PassportFixture {
    bytes32 internal constant CID = keccak256("vc-limits");
    address internal constant ASSET = address(0xA55E7);
    AgentReputationRegistry internal reputation;
    GroundedFeedback internal feedback;
    uint256 internal nonce;

    function setUp() public {
        _deployCore();
        reputation = new AgentReputationRegistry(IAgentIdentity(address(identity)));
        feedback = new GroundedFeedback(gate, IAgentReputation(address(reputation)));
        // This test contract is the relying party the mandate allows.
        _defaultClaims(ASSET, 100e6, 250e6, address(this));
        vm.prank(owner);
        status.anchor(CID, agentId, _root(), uint64(block.timestamp), uint64(block.timestamp + 365 days));
    }

    function _authorize(uint256 amount) internal returns (bytes32 actionId) {
        PassportGate.ActionIntent memory i =
            PassportGate.ActionIntent(CID, SWAP, ASSET, amount, address(this), ++nonce, vm.getBlockTimestamp() + 60);
        bytes memory sig = _signIntent(agentKey, i);
        (actionId,,) = gate.authorize(i, _presentation(CID), sig);
    }

    function _summary(address client, string memory tag1) internal view returns (uint64 count) {
        address[] memory clients = new address[](1);
        clients[0] = client;
        (count,,) = reputation.getSummary(agentId, clients, tag1, "");
    }

    /// SECURITY.md "Feedback is grounded, not Sybil-proof": the gate authorizes a zero-amount action, and its
    /// counterparty can then post grounded feedback for it — reputation for the cost of gas.
    function test_knownLimitation_zeroAmountActionEarnsGroundedFeedback() public {
        bytes32 actionId = _authorize(0);
        feedback.rate(actionId, 100, 0, "settled", "");
        assertEq(_summary(address(feedback), feedback.TAG()), 1);
        assertEq(gate.spentToday(CID, ASSET), 0);
    }

    /// SECURITY.md "The daily limit is a UTC calendar day": a full budget just before 00:00 UTC and another just
    /// after — twice the daily limit within minutes.
    function test_knownLimitation_dailyLimitResetsAtUtcMidnight() public {
        uint256 dayStart = (vm.getBlockTimestamp() / 1 days + 1) * 1 days;
        vm.warp(dayStart - 60); // 23:59 UTC
        _authorize(100e6);
        _authorize(100e6);
        _authorize(50e6);
        assertEq(gate.spentToday(CID, ASSET), 250e6);
        vm.warp(dayStart + 60); // 00:01 UTC, two minutes later
        _authorize(100e6);
        _authorize(100e6);
        _authorize(50e6);
        assertEq(gate.spentToday(CID, ASSET), 250e6, "a fresh budget after midnight");
    }

    /// SECURITY.md "One daily budget per mandate and asset": the daily limit is not split by scope or by
    /// counterparty — swaps at one allowed payee and a loan at another draw from the same budget.
    function test_knownLimitation_dailyBudgetSharedAcrossScopesAndPayees() public {
        address lender = makeAddr("lender");
        claims.push(Claim(keccak256("s7"), PassportClaims.payeeKey(lender), PassportClaims.ALLOWED));
        bytes32 cid = keccak256("vc-shared-budget");
        _anchor(cid); // scopes dex.swap and lending.borrow; payees this contract and the lender

        _act(cid, 0, 6, address(this), 100e6); // dex.swap here
        _act(cid, 0, 6, address(this), 100e6);
        _act(cid, 1, 7, lender, 50e6); // lending.borrow at another counterparty
        assertEq(gate.spentToday(cid, ASSET), 250e6, "one budget: 250 across two scopes and two payees");

        (PassportGate.ActionIntent memory i, PassportGate.Presentation memory p, bytes memory sig) =
            _intent(cid, 1, 7, lender, 1e6);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(PassportGate.NotAuthorized.selector, PassportGate.Reason.ExceedsDailyLimit));
        gate.authorize(i, p, sig);
    }

    /// An intent for credential `cid`, disclosing the scope claim `scopeIndex` and the payee claim `payeeIndex`.
    function _intent(bytes32 cid, uint256 scopeIndex, uint256 payeeIndex, address relyingParty, uint256 amount)
        internal
        returns (PassportGate.ActionIntent memory i, PassportGate.Presentation memory p, bytes memory sig)
    {
        p = _presentation(cid);
        p.scope = _disclose(scopeIndex);
        p.payee = _disclose(payeeIndex);
        i = PassportGate.ActionIntent(
            cid, claims[scopeIndex].value, ASSET, amount, relyingParty, ++nonce, vm.getBlockTimestamp() + 60
        );
        sig = _signIntent(agentKey, i);
    }

    function _act(bytes32 cid, uint256 scopeIndex, uint256 payeeIndex, address relyingParty, uint256 amount) internal {
        (PassportGate.ActionIntent memory i, PassportGate.Presentation memory p, bytes memory sig) =
            _intent(cid, scopeIndex, payeeIndex, relyingParty, amount);
        vm.prank(relyingParty);
        gate.authorize(i, p, sig);
    }

    /// SECURITY.md "The registry also takes direct feedback": anyone but the owner can rate an agent directly;
    /// only the GroundedFeedback client filter separates grounded ratings from those.
    function test_knownLimitation_registryTakesDirectFeedback() public {
        string memory tag = feedback.TAG();
        feedback.rate(_authorize(10e6), 100, 0, "settled", "");
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        reputation.giveFeedback(agentId, 100, 0, tag, "", "", "", bytes32(0));

        address[] memory both = new address[](2);
        both[0] = address(feedback);
        both[1] = stranger;
        (uint64 all,,) = reputation.getSummary(agentId, both, tag, "");
        assertEq(all, 2, "the registry counts the direct rating, even with the grounded tag");
        assertEq(_summary(stranger, tag), 1);
        assertEq(_summary(address(feedback), tag), 1, "filtering by the GroundedFeedback client leaves only the grounded one");
    }
}
