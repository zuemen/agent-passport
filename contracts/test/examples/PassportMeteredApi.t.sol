// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PassportGate} from "../../src/PassportGate.sol";
import {PassportGuarded} from "../../src/PassportGuarded.sol";
import {PassportClaims} from "../../src/libraries/PassportClaims.sol";
import {MockToken} from "../../src/demo/MockToken.sol";
import {PassportFixture} from "../utils/PassportFixture.sol";
import {PassportMeteredApi} from "./PassportMeteredApi.sol";

/// @notice The check-only integration style: the agent pays from its own wallet, the gate decides whether it may.
contract PassportMeteredApiTest is PassportFixture {
    MockToken internal usdc;
    PassportMeteredApi internal api;

    bytes32 internal constant CID = keccak256("vc-api");
    bytes32 internal constant CALL = keccak256("api.call");
    address internal treasury = makeAddr("api-treasury");

    function setUp() public {
        _deployCore();
        usdc = new MockToken("Mock USD", "mUSD", 6);
        api = new PassportMeteredApi(gate, treasury);

        // The agent holds its own small budget; the mandate caps what it may spend here.
        usdc.mint(agentWallet, 500e6);
        vm.prank(agentWallet);
        usdc.approve(address(api), type(uint256).max);

        _defaultClaims(address(usdc), 100e6, 250e6, address(api));
        claims[1] = Claim(keccak256("s1"), PassportClaims.KEY_SCOPE, CALL); // grant "api.call" instead of lending
        _anchor(CID);
    }

    function _intent(uint256 amount, uint256 nonce) internal view returns (PassportGate.ActionIntent memory) {
        return PassportGate.ActionIntent(CID, CALL, address(usdc), amount, address(api), nonce, block.timestamp + 60);
    }

    function _callPresentation() internal view returns (PassportGate.Presentation memory p) {
        p = _presentation(CID);
        p.scope = _disclose(1);
    }

    function _pay(uint256 amount, uint256 nonce) internal returns (bytes32) {
        PassportGate.ActionIntent memory i = _intent(amount, nonce);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _callPresentation();
        vm.prank(agentWallet);
        return api.payForCall(keccak256("GET /quote"), i, p, sig);
    }

    function test_checkOnly_withinLimit_chargesAgentWallet() public {
        bytes32 actionId = _pay(5e6, 1);
        assertEq(usdc.balanceOf(treasury), 5e6);
        assertEq(usdc.balanceOf(agentWallet), 495e6);
        assertEq(api.paidRequests(actionId), keccak256("GET /quote"));
        assertEq(gate.spentToday(CID, address(usdc)), 5e6);
    }

    function test_checkOnly_dailyLimitIsBooked() public {
        _pay(100e6, 1);
        _pay(100e6, 2);
        PassportGate.ActionIntent memory i = _intent(60e6, 3);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _callPresentation();
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(PassportGate.NotAuthorized.selector, PassportGate.Reason.ExceedsDailyLimit));
        api.payForCall(keccak256("GET /quote"), i, p, sig);
    }

    function test_checkOnly_overPerCallLimit_rejected() public {
        PassportGate.ActionIntent memory i = _intent(150e6, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _callPresentation();
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(PassportGate.NotAuthorized.selector, PassportGate.Reason.ExceedsPerTxLimit));
        api.payForCall(keccak256("GET /quote"), i, p, sig);
        assertEq(usdc.balanceOf(agentWallet), 500e6);
    }

    function test_checkOnly_revoked_rejected() public {
        vm.prank(owner);
        status.revoke(CID, "owner-revoked");
        PassportGate.ActionIntent memory i = _intent(5e6, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _callPresentation();
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(PassportGate.NotAuthorized.selector, PassportGate.Reason.Revoked));
        api.payForCall(keccak256("GET /quote"), i, p, sig);
    }

    function test_checkOnly_revert_callerIsNotAgent() public {
        PassportGate.ActionIntent memory i = _intent(5e6, 1);
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _callPresentation();
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PassportGuarded.CallerIsNotAgent.selector, relayer, agentWallet));
        api.payForCall(keccak256("GET /quote"), i, p, sig);
    }

    function test_checkOnly_revert_wrongScope() public {
        PassportGate.ActionIntent memory i = _intent(5e6, 1);
        i.scope = SWAP;
        bytes memory sig = _signIntent(agentKey, i);
        PassportGate.Presentation memory p = _presentation(CID);
        vm.prank(agentWallet);
        vm.expectRevert(PassportMeteredApi.WrongScope.selector);
        api.payForCall(keccak256("GET /quote"), i, p, sig);
    }
}
