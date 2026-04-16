// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IOracleUSD {
    function viewPriceInUSD() external view returns (uint256);
}
