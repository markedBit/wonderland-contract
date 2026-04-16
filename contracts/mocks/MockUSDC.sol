// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IOracleUSD.sol";

/**
 * @title MockUSDC
 * @dev Mock USDC with 6 decimals for testnet deployments and local testing.
 *      Implements IOracleUSD so it can report its own price.
 */
contract MockUSDC is ERC20, IOracleUSD {
    uint256 public mockPrice;

    constructor() ERC20("Mock USDC", "mUSDC") {
        mockPrice = 1e18; // 1 USDC = $1
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMockPrice(uint256 _price) external {
        mockPrice = _price;
    }

    function viewPriceInUSD() external view override returns (uint256) {
        return mockPrice;
    }
}
