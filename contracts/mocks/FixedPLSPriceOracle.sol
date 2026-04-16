// SPDX-License-Identifier: MIT
pragma solidity 0.7.5;

/**
 * @title FixedPLSPriceOracle
 * @dev Mock Chainlink-compatible price oracle that returns a fixed PLS/USD price.
 *      Price: $0.000008921 USD (PRICE = 892 with 8 decimals)
 *      Used as the AggregatorV3Interface feed for EthBondDepository on testnets.
 */
contract FixedPLSPriceOracle {
    uint8 public constant decimals = 8;

    // $0.000008921 with 8 decimals → 892 (rounded)
    int256 public constant PRICE = 892;

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, PRICE, block.timestamp, block.timestamp, 1);
    }
}
