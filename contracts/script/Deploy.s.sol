// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentIdentityRegistry} from "../src/AgentIdentityRegistry.sol";
import {AgentReputationRegistry} from "../src/AgentReputationRegistry.sol";
import {AgentValidationRegistry} from "../src/AgentValidationRegistry.sol";
import {CredentialStatusRegistry} from "../src/CredentialStatusRegistry.sol";
import {PassportGate} from "../src/PassportGate.sol";
import {GroundedFeedback} from "../src/GroundedFeedback.sol";
import {PasskeyAccountFactory} from "../src/PasskeyAccount.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";
import {IAgentReputation} from "../src/interfaces/IAgentReputation.sol";
import {MockToken} from "../src/demo/MockToken.sol";
import {PassportDex} from "../src/demo/PassportDex.sol";
import {PassportMerchant} from "../src/demo/PassportMerchant.sol";

/// @notice Deploys the full Agent Passport stack plus the demo relying parties.
///
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
///
/// Env:
///   DEPLOYER_PRIVATE_KEY   required — a key generated for this project only
///   IDENTITY_REGISTRY      optional — reuse an existing ERC-8004 Identity Registry (e.g. the official one)
///   REPUTATION_REGISTRY    optional — reuse an existing ERC-8004 Reputation Registry
///   VLEI_VERIFIER          optional — address of the off-chain vLEI verifier service (default: deployer)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address identityAddr = vm.envOr("IDENTITY_REGISTRY", address(0));
        address reputationAddr = vm.envOr("REPUTATION_REGISTRY", address(0));
        address vleiVerifier = vm.envOr("VLEI_VERIFIER", deployer);

        vm.startBroadcast(pk);

        if (identityAddr == address(0)) identityAddr = address(new AgentIdentityRegistry());
        IAgentIdentity identity = IAgentIdentity(identityAddr);
        if (reputationAddr == address(0)) reputationAddr = address(new AgentReputationRegistry(identity));
        AgentValidationRegistry validation = new AgentValidationRegistry(identity);

        CredentialStatusRegistry status = new CredentialStatusRegistry(identity, deployer);
        status.setVleiVerifier(vleiVerifier, true);
        PassportGate gate = new PassportGate(identity, status);
        GroundedFeedback feedback = new GroundedFeedback(gate, IAgentReputation(reputationAddr));
        PasskeyAccountFactory passkeyFactory = new PasskeyAccountFactory();

        // ---- demo relying parties (testnet only)
        MockToken usd = new MockToken("Agent Passport Demo USD", "apUSD", 6);
        MockToken wmon = new MockToken("Agent Passport Demo WMON", "apWMON", 18);
        // 1 apUSD (1e6) -> 0.5 apWMON (5e17)
        PassportDex dex = new PassportDex(gate, usd, wmon, 5e29, feedback);
        PassportMerchant merchant = new PassportMerchant(gate, deployer);
        wmon.mint(address(dex), 10_000_000e18);
        usd.mint(address(dex), 10_000_000e6);

        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "identityRegistry", identityAddr);
        vm.serializeAddress(o, "reputationRegistry", reputationAddr);
        vm.serializeAddress(o, "validationRegistry", address(validation));
        vm.serializeAddress(o, "credentialStatusRegistry", address(status));
        vm.serializeAddress(o, "passportGate", address(gate));
        vm.serializeAddress(o, "groundedFeedback", address(feedback));
        vm.serializeAddress(o, "passkeyAccountFactory", address(passkeyFactory));
        vm.serializeAddress(o, "vleiVerifier", vleiVerifier);
        vm.serializeAddress(o, "demoUsd", address(usd));
        vm.serializeAddress(o, "demoWmon", address(wmon));
        vm.serializeAddress(o, "passportDex", address(dex));
        string memory json = vm.serializeAddress(o, "passportMerchant", address(merchant));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("PassportGate", address(gate));
        console2.log("deployment written to", path);
    }
}
