// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentValidationRegistry} from "../src/AgentValidationRegistry.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

contract AgentValidationRegistryTest is PassportFixture {
    AgentValidationRegistry internal val;
    address internal validator = makeAddr("validator");
    bytes32 internal constant REQ = keccak256("audit-2026-09");

    function setUp() public {
        _deployCore();
        val = new AgentValidationRegistry(IAgentIdentity(address(identity)));
    }

    function _request() internal {
        vm.prank(owner);
        val.validationRequest(validator, agentId, "ipfs://req", REQ);
    }

    function test_requestAndRespond() public {
        _request();
        vm.prank(validator);
        val.validationResponse(REQ, 88, "ipfs://resp", keccak256("resp"), "credential-audit");
        (address v, uint256 id, uint8 r,, string memory tag,) = val.getValidationStatus(REQ);
        assertEq(v, validator);
        assertEq(id, agentId);
        assertEq(r, 88);
        assertEq(tag, "credential-audit");

        (uint64 count, uint8 avg) = val.getSummary(agentId, new address[](0), "");
        assertEq(count, 1);
        assertEq(avg, 88);
        (count,) = val.getSummary(agentId, new address[](0), "other-tag");
        assertEq(count, 0);
        assertEq(val.getAgentValidations(agentId).length, 1);
        assertEq(val.getValidatorRequests(validator).length, 1);
    }

    function test_summary_ignoresUnansweredAndOtherValidators() public {
        _request();
        address[] memory only = new address[](1);
        only[0] = makeAddr("someone-else");
        vm.prank(validator);
        val.validationResponse(REQ, 50, "", bytes32(0), "");
        (uint64 count,) = val.getSummary(agentId, only, "");
        assertEq(count, 0);
    }

    function test_revert_request_notOperator() public {
        vm.expectRevert(AgentValidationRegistry.NotAgentOperator.selector);
        val.validationRequest(validator, agentId, "", REQ);
    }

    function test_revert_request_zeroValidatorAndDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(AgentValidationRegistry.ZeroValidator.selector);
        val.validationRequest(address(0), agentId, "", REQ);
        _request();
        vm.prank(owner);
        vm.expectRevert(AgentValidationRegistry.RequestExists.selector);
        val.validationRequest(validator, agentId, "", REQ);
    }

    function test_revert_response() public {
        vm.expectRevert(AgentValidationRegistry.UnknownRequest.selector);
        val.validationResponse(REQ, 1, "", bytes32(0), "");
        _request();
        vm.expectRevert(AgentValidationRegistry.NotValidator.selector);
        val.validationResponse(REQ, 1, "", bytes32(0), "");
        vm.prank(validator);
        vm.expectRevert(AgentValidationRegistry.ResponseOutOfRange.selector);
        val.validationResponse(REQ, 101, "", bytes32(0), "");
    }

    function test_revert_statusUnknown() public {
        vm.expectRevert(AgentValidationRegistry.UnknownRequest.selector);
        val.getValidationStatus(REQ);
    }
}
