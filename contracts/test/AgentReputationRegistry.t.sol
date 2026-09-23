// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentReputationRegistry} from "../src/AgentReputationRegistry.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

contract AgentReputationRegistryTest is PassportFixture {
    AgentReputationRegistry internal rep;
    address internal dex = makeAddr("dex");
    address internal lender = makeAddr("lender");

    function setUp() public {
        _deployCore();
        rep = new AgentReputationRegistry(IAgentIdentity(address(identity)));
    }

    function _give(address from, int128 value, uint8 dec, string memory tag1) internal {
        vm.prank(from);
        rep.giveFeedback(agentId, value, dec, tag1, "", "https://dex", "ipfs://fb", bytes32(0));
    }

    function test_giveFeedback_andRead() public {
        _give(dex, 95, 0, "settlement");
        (int128 v, uint8 d, string memory t1,, bool revoked) = rep.readFeedback(agentId, dex, 1);
        assertEq(v, 95);
        assertEq(d, 0);
        assertEq(t1, "settlement");
        assertFalse(revoked);
        assertEq(rep.getLastIndex(agentId, dex), 1);
        assertEq(rep.getClients(agentId).length, 1);
    }

    function test_getSummary_normalisesAndFilters() public {
        _give(dex, 90, 0, "settlement");
        _give(lender, 8000, 2, "settlement"); // 80.00
        _give(lender, 10, 0, "latency");
        address[] memory clients = new address[](2);
        clients[0] = dex;
        clients[1] = lender;

        (uint64 count, int128 avg, uint8 dec) = rep.getSummary(agentId, clients, "settlement", "");
        assertEq(count, 2);
        assertEq(dec, 18);
        assertEq(avg, 85e18);

        vm.prank(dex);
        rep.revokeFeedback(agentId, 1);
        (count, avg,) = rep.getSummary(agentId, clients, "settlement", "");
        assertEq(count, 1);
        assertEq(avg, 80e18);
    }

    function test_revert_selfFeedback_ownerAndOperator() public {
        vm.prank(owner);
        vm.expectRevert(AgentReputationRegistry.SelfFeedback.selector);
        rep.giveFeedback(agentId, 100, 0, "", "", "", "", bytes32(0));

        address op = makeAddr("op");
        vm.prank(owner);
        identity.approve(op, agentId);
        vm.prank(op);
        vm.expectRevert(AgentReputationRegistry.SelfFeedback.selector);
        rep.giveFeedback(agentId, 100, 0, "", "", "", "", bytes32(0));
    }

    function test_revert_giveFeedback_bounds() public {
        vm.startPrank(dex);
        vm.expectRevert(AgentReputationRegistry.TooManyDecimals.selector);
        rep.giveFeedback(agentId, 1, 19, "", "", "", "", bytes32(0));
        int128 tooBig = rep.MAX_ABS_VALUE() + 1;
        vm.expectRevert(AgentReputationRegistry.ValueOutOfRange.selector);
        rep.giveFeedback(agentId, tooBig, 0, "", "", "", "", bytes32(0));
        vm.stopPrank();
    }

    function test_revert_revokeFeedback() public {
        vm.prank(dex);
        vm.expectRevert(AgentReputationRegistry.UnknownFeedback.selector);
        rep.revokeFeedback(agentId, 1);

        _give(dex, 1, 0, "");
        vm.startPrank(dex);
        rep.revokeFeedback(agentId, 1);
        vm.expectRevert(AgentReputationRegistry.AlreadyRevoked.selector);
        rep.revokeFeedback(agentId, 1);
        vm.stopPrank();
    }

    function test_appendResponse_andReverts() public {
        vm.expectRevert(AgentReputationRegistry.UnknownFeedback.selector);
        rep.appendResponse(agentId, dex, 1, "ipfs://r", bytes32(0));
        _give(dex, 1, 0, "");
        vm.expectRevert(AgentReputationRegistry.EmptyURI.selector);
        rep.appendResponse(agentId, dex, 1, "", bytes32(0));
        vm.prank(owner);
        rep.appendResponse(agentId, dex, 1, "ipfs://r", bytes32(0));
    }

    function test_revert_getSummary_emptyClientList() public {
        vm.expectRevert(AgentReputationRegistry.ClientListRequired.selector);
        rep.getSummary(agentId, new address[](0), "", "");
    }
}
