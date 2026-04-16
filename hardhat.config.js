// PulseChain RPC endpoints use a self-signed / incomplete certificate chain.
// Disabling strict TLS verification is acceptable for a development/deployment tool.
// Never use this in production server code.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { networks: netConfig } = require("./scripts/config");

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  "0x0000000000000000000000000000000000000000000000000000000000000001";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "key";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        // MultiReward.sol
        version: "0.5.17",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        // IUniswapV2Router01.sol, IUniswapV2Router02.sol (pragma ^0.6.2)
        version: "0.6.6",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        // All core Wonderland contracts
        version: "0.7.5",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        // Redemption.sol (exact pragma 0.8.10)
        version: "0.8.10",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        // MockUSDC (^0.8.18), WonderZapIn (^0.8.0), IUniswapV2Pair (^0.8.0), IOracleUSD
        version: "0.8.18",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },

  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: netConfig.localhost.rpc,
      chainId: 31337,
    },
    pulseTestnet: {
      url: netConfig.pulseTestnet.rpc,
      chainId: 943,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
    },
    pulse: {
      url: netConfig.pulse.rpc,
      chainId: 369,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
    },
  },

  etherscan: {
    apiKey: {
      pulse: ETHERSCAN_API_KEY,
      pulseTestnet: ETHERSCAN_API_KEY,
    },
    customChains: [
      {
        network: "pulse",
        chainId: 369,
        urls: {
          apiURL: "https://api.scan.pulsechain.com/api/",
          browserURL: "https://scan.pulsechain.com/",
        },
      },
      {
        network: "pulseTestnet",
        chainId: 943,
        urls: {
          apiURL: "https://api.scan.v4.testnet.pulsechain.com/api/",
          browserURL: "https://scan.v4.testnet.pulsechain.com/",
        },
      },
    ],
  },

  sourcify: {
    enabled: true,
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },

  mocha: {
    timeout: 120000,
  },
};
