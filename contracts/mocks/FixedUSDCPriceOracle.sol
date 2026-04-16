// SPDX-License-Identifier: MIT
pragma solidity 0.7.5;

/**
 * @title FixedUSDCPriceOracle
 * @dev Mock Chainlink-compatible price oracle that returns a fixed USDC/USD price.
 *      Price: $1.00 (PRICE = 100000000 with 8 decimals)
 *      Can be used as an AggregatorV3Interface feed where needed.
 */
contract FixedUSDCPriceOracle {
    uint8 public constant decimals = 8;

    // $1.00 with 8 decimals
    int256 public constant PRICE = 100000000;

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
