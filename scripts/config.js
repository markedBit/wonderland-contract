/**
 * Wonderland Protocol – Static network configuration
 *
 * All contract addresses, RPC endpoints, and chain-specific constants live here.
 * Secrets (private key, API key) are the only things that belong in .env.
 */

const DAO_ADDRESS = "0x4Aa6Da4ca5d76e8d5e3ACD11B92Ab22D564F1fcb";

const networks = {
  // ── Local / CI ────────────────────────────────────────────────────────────
  hardhat: {
    rpc: "http://127.0.0.1:8545",
    wpls: null,         // MockWPLS deployed automatically
    usdc: null,         // MockUSDC deployed automatically
    router: null,       // MockUniswapV2Pair used instead
    dao: null,          // falls back to deployer address
    isLocal: true,
  },
  localhost: {
    rpc: "http://127.0.0.1:8545",
    wpls: null,
    usdc: null,
    router: null,
    dao: null,
    isLocal: true,
  },

  // ── PulseChain Testnet (chainId 943) ──────────────────────────────────────
  pulseTestnet: {
    rpc: "https://rpc.v4.testnet.pulsechain.com",
    wpls: "0x70499adEBB11Efd915E3b69E700c331778628707",
    usdc: null,         // MockUSDC deployed on testnet
    router: "0x636f6407B90661b73b1C0F7e24F4C79f624d0738",
    dao: DAO_ADDRESS,
    isLocal: false,

    // Initial LP liquidity amounts for deployLP.js.
    //
    // TIME launch price = $10 USDC.
    // WPLS price        = $0.000008921  →  1 TIME = $10/$0.000008921 = 1,120,952 WPLS
    //
    // Testnet deployer budget: ~30 tPLS (wrapped → tWPLS).
    // Absolute amounts are tiny; the ratio is what matters for price discovery.
    lp: {
      timeUsdc: { time: "1",          usdc: "10"   }, // 1 TIME = 10 USDC
      timeWpls: { time: "0.00002676", wpls: "30"   }, // 0.00002676 TIME ≈ 30 WPLS at correct ratio
    },
  },

  // ── PulseChain Mainnet (chainId 369) ──────────────────────────────────────
  pulse: {
    rpc: "https://rpc.pulsechain.com",
    wpls: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
    usdc: "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07",
    router: "0x165C3410fC91EF562C50559f7d2289fEbed552d9",
    dao: DAO_ADDRESS,
    isLocal: false,

    // Mainnet launch liquidity. Adjust before running deployLP.js.
    // Ratio: 1 TIME = $10 USDC = 1,120,952 WPLS (at $0.000008921/WPLS).
    lp: {
      timeUsdc: { time: "1", usdc: "10"          }, // 1 TIME + 10 USDC
      timeWpls: { time: "1", wpls: "1120952"     }, // 1 TIME + 1,120,952 WPLS
    },
  },
};

/**
 * Returns the network config for the given Hardhat network name.
 * Falls back to hardhat (local) defaults for unknown networks.
 */
function getConfig(networkName) {
  return networks[networkName] || networks.hardhat;
}

module.exports = { getConfig, DAO_ADDRESS, networks };
