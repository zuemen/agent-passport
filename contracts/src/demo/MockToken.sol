// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only ERC-20 with an open faucet. Demo use on testnet only — no value.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;
    uint256 public constant FAUCET_AMOUNT_UNITS = 10_000;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT_UNITS * 10 ** _decimals);
    }
}
