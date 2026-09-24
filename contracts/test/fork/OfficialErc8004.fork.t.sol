// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CredentialStatusRegistry} from "../../src/CredentialStatusRegistry.sol";
import {PassportGate} from "../../src/PassportGate.sol";
import {PassportClaims} from "../../src/libraries/PassportClaims.sol";
import {IAgentIdentity} from "../../src/interfaces/IAgentIdentity.sol";
import {IAgentReputation} from "../../src/interfaces/IAgentReputation.sol";
import {GroundedFeedback} from "../../src/GroundedFeedback.sol";

interface IOfficialIdentity {
    function register(string memory agentURI) external returns (uint256);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 agentId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getVersion() external pure returns (string memory);
}

interface IOfficialReputation {
    function getIdentityRegistry() external view returns (address);
    function getClients(uint256 agentId) external view returns (address[] memory);
}

/// @notice Agent Passport on top of the *official* ERC-8004 Identity and Reputation registries deployed on Monad testnet
///         (erc-8004/erc-8004-contracts). Runs against a fork:
///             MONAD_FORK_URL=https://testnet-rpc.monad.xyz forge test --match-path "test/fork/*"
///         Skipped when MONAD_FORK_URL is not set.
contract OfficialErc8004ForkTest is Test {
    address constant OFFICIAL_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant OFFICIAL_REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    IOfficialIdentity identity = IOfficialIdentity(OFFICIAL_IDENTITY);
    CredentialStatusRegistry status;
    PassportGate gate;
    address owner = makeAddr("fork-owner");
    uint256 agentKey = 0xA9E17;
    uint256 agentId;
    bytes32 constant CID = keccak256("fork-vc");

    bytes32 salt0 = keccak256("f0");
    bytes32 salt1 = keccak256("f1");
    bytes32 salt2 = keccak256("f2");
    bytes32 salt3 = keccak256("f3");
    address asset = address(0xA55E7);
    bytes32[4] leaves;

    function setUp() public {
        string memory url = vm.envOr("MONAD_FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);

        status = new CredentialStatusRegistry(IAgentIdentity(OFFICIAL_IDENTITY), address(this));
        gate = new PassportGate(IAgentIdentity(OFFICIAL_IDENTITY), status);

        vm.prank(owner);
        agentId = identity.register("data:application/json;base64,e30=");

        // Bind the agent key using the official registry's own EIP-712 domain.
        address wallet = vm.addr(agentKey);
        uint256 deadline = block.timestamp + 60;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                wallet,
                owner,
                deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                OFFICIAL_IDENTITY
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(owner);
        identity.setAgentWallet(agentId, wallet, deadline, abi.encodePacked(r, s, v));

        leaves[0] = PassportClaims.leaf(salt0, PassportClaims.KEY_SCOPE, keccak256("dex.swap"));
        leaves[1] = PassportClaims.leaf(salt1, PassportClaims.maxPerTxKey(asset), bytes32(uint256(100e6)));
        leaves[2] = PassportClaims.leaf(salt2, PassportClaims.dailyLimitKey(asset), bytes32(uint256(250e6)));
        leaves[3] = PassportClaims.leaf(salt3, PassportClaims.payeeKey(address(this)), PassportClaims.ALLOWED);

        vm.prank(owner);
        status.anchor(CID, agentId, _root(), uint64(block.timestamp), uint64(block.timestamp + 1 days));
    }

    function _h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _root() internal view returns (bytes32) {
        return _h(_h(leaves[0], leaves[1]), _h(leaves[2], leaves[3]));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[i ^ 1];
        p[1] = i < 2 ? _h(leaves[2], leaves[3]) : _h(leaves[0], leaves[1]);
    }

    function _presentation() internal view returns (PassportGate.Presentation memory p) {
        p.credentialId = CID;
        p.scope = PassportGate.Disclosure(salt0, PassportClaims.KEY_SCOPE, keccak256("dex.swap"), _proof(0));
        p.maxPerTx = PassportGate.Disclosure(salt1, PassportClaims.maxPerTxKey(asset), bytes32(uint256(100e6)), _proof(1));
        p.dailyLimit = PassportGate.Disclosure(salt2, PassportClaims.dailyLimitKey(asset), bytes32(uint256(250e6)), _proof(2));
        p.payee = PassportGate.Disclosure(salt3, PassportClaims.payeeKey(address(this)), PassportClaims.ALLOWED, _proof(3));
    }

    function test_fork_officialRegistry_endToEnd() public {
        assertEq(identity.getAgentWallet(agentId), vm.addr(agentKey), "official registry bound the wallet");
        assertTrue(status.isActive(CID));

        PassportGate.Presentation memory p = _presentation();
        assertEq(uint8(gate.check(agentId, keccak256("dex.swap"), asset, 80e6, address(this), p)), uint8(PassportGate.Reason.Ok));
        assertEq(
            uint8(gate.check(agentId, keccak256("dex.swap"), asset, 150e6, address(this), p)),
            uint8(PassportGate.Reason.ExceedsPerTxLimit)
        );

        PassportGate.ActionIntent memory intent = PassportGate.ActionIntent(
            CID, keccak256("dex.swap"), asset, 80e6, address(this), 1, block.timestamp + 60
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, gate.hashIntent(intent));
        (, uint256 id, address wallet) = gate.authorize(intent, p, abi.encodePacked(r, s, v));
        assertEq(id, agentId);
        assertEq(wallet, vm.addr(agentKey));
    }

    function test_fork_transferOnOfficialRegistry_invalidates() public {
        vm.prank(owner);
        identity.transferFrom(owner, makeAddr("buyer"), agentId);
        // The official registry clears agentWallet on transfer; our status registry flags the issuer.
        assertEq(identity.getAgentWallet(agentId), address(0));
        assertEq(uint8(status.statusOf(CID)), uint8(CredentialStatusRegistry.Status.IssuerNotOwner));
    }

    /// Feedback for a gate-authorized action lands in the official Reputation Registry, once per action.
    function test_fork_groundedFeedback_landsInOfficialReputation() public {
        IOfficialReputation rep = IOfficialReputation(OFFICIAL_REPUTATION);
        assertEq(rep.getIdentityRegistry(), OFFICIAL_IDENTITY, "official reputation points at the official identity");
        GroundedFeedback feedback = new GroundedFeedback(gate, IAgentReputation(OFFICIAL_REPUTATION));

        PassportGate.ActionIntent memory intent = PassportGate.ActionIntent(
            CID, keccak256("dex.swap"), asset, 80e6, address(this), 7, block.timestamp + 60
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, gate.hashIntent(intent));
        (bytes32 actionId,,) = gate.authorize(intent, _presentation(), abi.encodePacked(r, s, v));

        // This test contract is the action's relying party, so it may rate it — once.
        feedback.rate(actionId, 100, 0, "settled", "");
        address[] memory clients = rep.getClients(agentId);
        bool found;
        for (uint256 i; i < clients.length; ++i) {
            if (clients[i] == address(feedback)) found = true;
        }
        assertTrue(found, "GroundedFeedback is a client of the agent in the official registry");

        vm.expectRevert(GroundedFeedback.AlreadyRated.selector);
        feedback.rate(actionId, 100, 0, "settled", "");
    }
}
