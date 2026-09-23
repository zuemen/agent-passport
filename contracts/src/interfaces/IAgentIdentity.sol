// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of an ERC-8004 Identity Registry that Agent Passport depends on.
/// @dev Satisfied both by our `AgentIdentityRegistry` and by the official ERC-8004 reference
///      deployment on Monad testnet, so the credential layer can sit on top of either.
interface IAgentIdentity {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}
