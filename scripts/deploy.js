/**
 * Wonderland Protocol – Main Deployment Script
 *
 * Deployment order follows the PDF guide (with corrections noted):
 *   1.  TimeERC20Token (TIME)
 *   2.  MEMOries (MEMO)
 *   3.  TimeBondingCalculator
 *   4.  TimeTreasury
 *   5.  TIME.setVault(treasury)
 *   6.  TimeStaking
 *   7.  MEMO.initialize(staking)
 *   8.  StakingWarmup
 *   9.  Distributor
 *   10. Distributor.addRecipient(staking, 5000)
 *   11. Staking.setContract(0 = DISTRIBUTOR, distributor)
 *   12. Staking.setContract(1 = WARMUP, warmup)
 *   13. StakingHelper(staking, TIME)  ← PDF has arg order backwards
 *   14. FixedPLSPriceOracle
 *   15. EthBondDepository (WPLS bond)
 *   16. BondDepository #1 (USDC reserve bond)
 *   17. BondDepository #2 (TIME-USDC LP bond)  – skipped if no LP address
 *   18. BondDepository #3 (TIME-WPLS LP bond)  – skipped if no LP address
 *   19. Treasury permissions (queue + toggle)
 *   20. wMEMO
 *
 * LP bond depositories (steps 17–18) require LP pair addresses.
 * On local Hardhat, MockUniswapV2Pair contracts are deployed automatically.
 * On live networks, run deployLP.js first (it saves LP addresses to the
 * deployments JSON), then re-run this script — it will pick them up automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hardhat
 *   npx hardhat run scripts/deploy.js --network pulseTestnet
 *   npx hardhat run scripts/deploy.js --network pulse
 */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { getConfig } = require("./config");

// ── Helpers ──────────────────────────────────────────────────────────────────

async function deploy(contractName, args = [], label = null) {
  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  ✓ ${label || contractName}: ${addr}`);
  return contract;
}

async function queueAndToggle(treasury, managing, address, calculator = ethers.ZeroAddress) {
  await (await treasury.queue(managing, address)).wait();
  await (await treasury.toggle(managing, address, calculator)).wait();
}

function loadDeploymentIfExists(networkName) {
  const file = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function saveDeployment(networkName, data) {
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${networkName}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\n  Deployment saved → deployments/${networkName}.json`);
}

// ── Treasury MANAGING enum ───────────────────────────────────────────────────
const MANAGING = {
  RESERVEDEPOSITOR: 0,
  RESERVESPENDER: 1,
  RESERVETOKEN: 2,
  RESERVEMANAGER: 3,
  LIQUIDITYDEPOSITOR: 4,
  LIQUIDITYTOKEN: 5,
  LIQUIDITYMANAGER: 6,
  DEBTOR: 7,
  REWARDMANAGER: 8,
  SOHM: 9,
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const networkName = network.name;
  const [deployer] = await ethers.getSigners();
  const cfg = getConfig(networkName);

  // On local networks use the deployer as DAO; on live networks use the fixed address
  const daoAddress = cfg.dao || deployer.address;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Wonderland Deployment`);
  console.log(`  Network  : ${networkName}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  DAO      : ${daoAddress}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const deployment = { network: networkName, deployer: deployer.address, dao: daoAddress };

  // ── Step 1-2: Core tokens ─────────────────────────────────────────────────
  console.log("[ 1 ] Deploying core tokens…");
  const time = await deploy("TimeERC20Token");
  const memo = await deploy("MEMOries");
  const timeAddr = await time.getAddress();
  const memoAddr = await memo.getAddress();

  // ── Step 3: Bonding calculator ────────────────────────────────────────────
  console.log("\n[ 3 ] Deploying bonding calculator…");
  const bondCalc = await deploy("TimeBondingCalculator", [timeAddr]);
  const bondCalcAddr = await bondCalc.getAddress();

  // ── Mock / real USDC & WPLS ───────────────────────────────────────────────
  console.log("\n[mock] Resolving USDC and WPLS…");
  let usdcAddr = cfg.usdc;
  let wplsAddr = cfg.wpls;

  if (!usdcAddr) {
    const mockUsdc = await deploy("MockUSDC", [], "MockUSDC");
    usdcAddr = await mockUsdc.getAddress();
    deployment.mockUSDC = usdcAddr;

    // Always mint to deployer when using a mock – needed for the initial treasury
    // deposit on both local and testnet. Mainnet uses real USDC (cfg.usdc is set).
    await (await mockUsdc.mint(deployer.address, ethers.parseUnits("10000000", 6))).wait();
    console.log(`       Minted 10,000,000 mUSDC → ${deployer.address}`);
  }

  if (!wplsAddr) {
    const mockWpls = await deploy("MockWPLS", [], "MockWPLS");
    wplsAddr = await mockWpls.getAddress();
    deployment.mockWPLS = wplsAddr;

    // Same: always mint when deploying a mock WPLS
    await (await mockWpls.mint(deployer.address, ethers.parseEther("10000000"))).wait();
    console.log(`       Minted 10,000,000 MockWPLS → ${deployer.address}`);
  }

  deployment.usdc = usdcAddr;
  deployment.wpls = wplsAddr;

  // ── Step 4: Treasury ──────────────────────────────────────────────────────
  // Constructor: (_Time, _MIM/USDC, _secondsNeededForQueue, _limitAmount)
  // PDF had only 3 args; contract has 4.
  // secondsNeededForQueue = 0 → no timelock on permission changes
  // limitAmount = MaxUint256 → no hourly mint cap (0 would block all deposits)
  console.log("\n[ 4 ] Deploying Treasury…");
  const treasury = await deploy("TimeTreasury", [timeAddr, usdcAddr, 0, ethers.MaxUint256]);
  const treasuryAddr = await treasury.getAddress();

  // ── Step 5: TIME.setVault ─────────────────────────────────────────────────
  console.log("\n[ 5 ] Setting TIME vault → Treasury…");
  await (await time.setVault(treasuryAddr)).wait();

  // ── Step 6: Staking ───────────────────────────────────────────────────────
  // Epoch: 28800s (8 hours), firstEpochNumber: 1 (not 0!)
  // firstEpochTime = now: epoch.endTime <= block.timestamp immediately, so the
  // first stake triggers a rebase right away rather than waiting 8 hours.
  // firstEpochNumber must be ≥ 1 so warmup expiry (epochNumber + 0) is non-zero,
  // allowing StakingHelper.claim to work on the very first stake.
  console.log("\n[ 6 ] Deploying TimeStaking…");
  const EPOCH_LENGTH = 28800;
  const firstEpochTime = Math.floor(Date.now() / 1000) + EPOCH_LENGTH;
  const staking = await deploy("TimeStaking", [
    timeAddr,
    memoAddr,
    EPOCH_LENGTH,
    1,             // firstEpochNumber = 1 (not 0)
    firstEpochTime, // first epoch ends 8 hours from deployment
  ]);
  const stakingAddr = await staking.getAddress();

  // ── Step 7: MEMO.initialize ───────────────────────────────────────────────
  console.log("\n[ 7 ] Initializing MEMO with staking contract…");
  await (await memo.initialize(stakingAddr)).wait();

  // ── Step 8: StakingWarmup ─────────────────────────────────────────────────
  console.log("\n[ 8 ] Deploying StakingWarmup…");
  const warmup = await deploy("StakingWarmup", [stakingAddr, memoAddr]);
  const warmupAddr = await warmup.getAddress();

  // ── Step 9: StakingDistributor ────────────────────────────────────────────
  console.log("\n[ 9 ] Deploying Distributor…");
  const distributor = await deploy("Distributor", [
    treasuryAddr,
    timeAddr,
    EPOCH_LENGTH,
    firstEpochTime, // mirrors staking epoch timing
  ]);
  const distributorAddr = await distributor.getAddress();

  // ── Step 10: addRecipient(staking, 5000) → 0.5% per epoch ────────────────
  console.log("\n[ 10 ] Distributor.addRecipient(staking, 5000)…");
  await (await distributor.addRecipient(stakingAddr, 5000)).wait();

  // ── Steps 11-12: Wire staking contracts ───────────────────────────────────
  console.log("\n[ 11-12 ] Wiring Distributor + Warmup into Staking…");
  await (await staking.setContract(0, distributorAddr)).wait(); // DISTRIBUTOR
  await (await staking.setContract(1, warmupAddr)).wait();      // WARMUP

  // ── Step 13: StakingHelper ────────────────────────────────────────────────
  // NOTE: PDF says (TIME, Staking) but contract constructor is (_staking, _Time)
  console.log("\n[ 13 ] Deploying StakingHelper(staking, TIME)…");
  const stakingHelper = await deploy("StakingHelper", [stakingAddr, timeAddr]);
  const stakingHelperAddr = await stakingHelper.getAddress();

  // ── Step 14: Price oracle ─────────────────────────────────────────────────
  console.log("\n[ 14 ] Deploying FixedPLSPriceOracle…");
  const plsOracle = await deploy("FixedPLSPriceOracle");
  const plsOracleAddr = await plsOracle.getAddress();

  // ── Step 15: EthBondDepository (WPLS / native asset bond) ─────────────────
  // initializeBondTerms(controlVariable, minimumPrice, maxPayout, maxDebt, vestingTerm)
  // NOTE: PDF's 6-arg call is for BondDepository (with fee). EthBond takes 5 args.
  // NOTE: vestingTerm 432000 > 129600 (36h minimum) ✓
  // Fully qualified name required: both BondDepository files define TimeBondDepository
  console.log("\n[ 15 ] Deploying EthBondDepository (WPLS)…");
  const ethBond = await deploy("contracts/EthBondDepository.sol:TimeBondDepository", [
    timeAddr,
    wplsAddr,
    treasuryAddr,
    daoAddress,
    plsOracleAddr,
  ]);
  const ethBondAddr = await ethBond.getAddress();

  // EthBond uses a different payout multiplier (÷1e14 vs ÷1e16 for reserve bonds),
  // so its minimumPrice does NOT map to "USDC per TIME" the same way.
  // minimumPrice=17000 here gives a reasonable WPLS→TIME exchange rate.
  await (await ethBond.initializeBondTerms(
    257,
    17000,
    1000,
    "1000000000000000000000000",
    432000
  )).wait();
  await (await ethBond.setStaking(stakingHelperAddr, true)).wait();
  console.log("       EthBond terms initialized (minimumPrice=17000)");

  // ── Step 16: BondDepository #1 – USDC reserve bond ───────────────────────
  // initializeBondTerms(controlVariable, minimumPrice, maxPayout, fee, maxDebt, vestingTerm)
  // minimumPrice=1000 → $10 USDC per TIME  (formula: price = minimumPrice / 100)
  console.log("\n[ 16 ] Deploying BondDepository #1 (USDC reserve bond)…");
  const usdcBond = await deploy("contracts/BondDepository.sol:TimeBondDepository", [
    timeAddr,
    usdcAddr,
    treasuryAddr,
    daoAddress,
    ethers.ZeroAddress,
  ], "BondDepository(USDC)");
  const usdcBondAddr = await usdcBond.getAddress();

  await (await usdcBond.initializeBondTerms(
    257,
    1000,
    1000,
    100,
    "1000000000000000000000000",
    432000
  )).wait();
  await (await usdcBond.setStaking(stakingHelperAddr, true)).wait();
  console.log("       USDC bond terms initialized (minimumPrice=1000 → $10/TIME)");

  // ── Steps 17-18: LP bond depositories ────────────────────────────────────
  // LOCAL ONLY: Deploy MockUniswapV2Pair stand-ins and LP bond depositories.
  // LIVE NETWORKS: LP pairs are created via PulseX in deployLP.js (run that next).
  //   deployLP.js also deploys LP bond depositories and wires them to the treasury.

  let usdcLpBond, usdcLpBondAddr;
  let wplsLpBond, wplsLpBondAddr;
  let timeusdcLPAddr = null;
  let timewplsLPAddr = null;

  if (cfg.isLocal) {
    console.log("\n[ 17-18 ] Local network — deploying MockUniswapV2Pair + LP bonds…");

    const MockLP = await ethers.getContractFactory("MockUniswapV2Pair");

    const lpUsdc = await MockLP.deploy(timeAddr, usdcAddr);
    await lpUsdc.waitForDeployment();
    timeusdcLPAddr = await lpUsdc.getAddress();

    // Reserves at $10/TIME: 1,000 TIME + 10,000 USDC
    await (await lpUsdc.setReserves(
      ethers.parseUnits("1000", 9),
      ethers.parseUnits("10000", 6)
    )).wait();
    await (await lpUsdc.mint(deployer.address, ethers.parseEther("1000"))).wait();
    console.log(`  ✓ MockLP(TIME-USDC): ${timeusdcLPAddr}`);

    const lpWpls = await MockLP.deploy(timeAddr, wplsAddr);
    await lpWpls.waitForDeployment();
    timewplsLPAddr = await lpWpls.getAddress();

    // Reserves: 1,000 TIME + 1,120,952,000 WPLS  (1 TIME = 1,120,952 WPLS at $10 TIME / $0.000008921 WPLS)
    await (await lpWpls.setReserves(
      ethers.parseUnits("1000", 9),
      ethers.parseEther("1120952000")
    )).wait();
    await (await lpWpls.mint(deployer.address, ethers.parseEther("1000"))).wait();
    console.log(`  ✓ MockLP(TIME-WPLS): ${timewplsLPAddr}`);

    deployment.mockLpUsdcTime = timeusdcLPAddr;
    deployment.mockLpWplsTime = timewplsLPAddr;

    // Deploy LP bonds immediately for local
    console.log("\n[ 17 ] Deploying BondDepository #2 (TIME-USDC LP bond)…");
    usdcLpBond = await deploy("contracts/BondDepository.sol:TimeBondDepository", [
      timeAddr, timeusdcLPAddr, treasuryAddr, daoAddress, bondCalcAddr,
    ], "BondDepository(TIME-USDC LP)");
    usdcLpBondAddr = await usdcLpBond.getAddress();
    await (await usdcLpBond.initializeBondTerms(257, 1000, 1000, 100, "1000000000000000000000000", 432000)).wait();
    await (await usdcLpBond.setStaking(stakingHelperAddr, true)).wait();
    console.log("       TIME-USDC LP bond terms initialized");

    console.log("\n[ 18 ] Deploying BondDepository #3 (TIME-WPLS LP bond)…");
    wplsLpBond = await deploy("contracts/BondDepository.sol:TimeBondDepository", [
      timeAddr, timewplsLPAddr, treasuryAddr, daoAddress, bondCalcAddr,
    ], "BondDepository(TIME-WPLS LP)");
    wplsLpBondAddr = await wplsLpBond.getAddress();
    await (await wplsLpBond.initializeBondTerms(257, 1000, 1000, 100, "1000000000000000000000000", 432000)).wait();
    await (await wplsLpBond.setStaking(stakingHelperAddr, true)).wait();
    console.log("       TIME-WPLS LP bond terms initialized");

  } else {
    console.log("\n[ 17-18 ] Live network — LP bond deployment deferred to deployLP.js");
    console.log("          After this script completes:");
    console.log("          1. Wrap tPLS → WPLS: WPLS.deposit{value}()");
    console.log("          2. Run: npm run deploy-lp:testnet   (or :mainnet)");
  }

  // ── Step 19: Treasury permissions ────────────────────────────────────────
  // USDC is already a reserve token (set in Treasury constructor).
  // All queue + toggle calls can be immediate because secondsNeededForQueue = 0.
  console.log("\n[ 19 ] Setting up Treasury permissions…");

  // WPLS as reserve token (USDC already set in constructor)
  await queueAndToggle(treasury, MANAGING.RESERVETOKEN, wplsAddr);
  console.log("       ✓ WPLS added as reserve token");

  // DAO as reserve depositor, manager, liquidity manager
  await queueAndToggle(treasury, MANAGING.RESERVEDEPOSITOR, daoAddress);
  console.log("       ✓ DAO → reserve depositor");

  await queueAndToggle(treasury, MANAGING.RESERVEMANAGER, daoAddress);
  console.log("       ✓ DAO → reserve manager");

  await queueAndToggle(treasury, MANAGING.LIQUIDITYMANAGER, daoAddress);
  console.log("       ✓ DAO → liquidity manager");

  // ETH bond as reserve depositor
  await queueAndToggle(treasury, MANAGING.RESERVEDEPOSITOR, ethBondAddr);
  console.log("       ✓ EthBond → reserve depositor");

  // USDC reserve bond as reserve depositor
  await queueAndToggle(treasury, MANAGING.RESERVEDEPOSITOR, usdcBondAddr);
  console.log("       ✓ USDCBond → reserve depositor");

  // LP bonds as liquidity depositors + LP tokens
  if (usdcLpBondAddr && timeusdcLPAddr) {
    await queueAndToggle(treasury, MANAGING.LIQUIDITYDEPOSITOR, usdcLpBondAddr);
    console.log("       ✓ USDCLPBond → liquidity depositor");

    await queueAndToggle(treasury, MANAGING.LIQUIDITYTOKEN, timeusdcLPAddr, bondCalcAddr);
    console.log("       ✓ TIME-USDC LP → liquidity token");
  }

  if (wplsLpBondAddr && timewplsLPAddr) {
    await queueAndToggle(treasury, MANAGING.LIQUIDITYDEPOSITOR, wplsLpBondAddr);
    console.log("       ✓ WPLSLPBond → liquidity depositor");

    await queueAndToggle(treasury, MANAGING.LIQUIDITYTOKEN, timewplsLPAddr, bondCalcAddr);
    console.log("       ✓ TIME-WPLS LP → liquidity token");
  }

  // Distributor as reward manager (mints TIME on epoch rebase)
  await queueAndToggle(treasury, MANAGING.REWARDMANAGER, distributorAddr);
  console.log("       ✓ Distributor → reward manager");

  // EthBond as reward manager (calls treasury.mintRewards instead of treasury.deposit)
  await queueAndToggle(treasury, MANAGING.REWARDMANAGER, ethBondAddr);
  console.log("       ✓ EthBond → reward manager");

  // MEMO as sOHM (used for debt limit checks)
  await queueAndToggle(treasury, MANAGING.SOHM, memoAddr);
  console.log("       ✓ MEMO set as sOHM");

  // ── Initial treasury deposit to seed TIME supply ─────────────────────────
  // Needed so the deployer has TIME to stake for MEMO index initialization.
  // On local networks, deployer has mock USDC from the earlier mint step.
  // On live networks, deployer must hold USDC before running this script.
  console.log("\n[init] Initial treasury deposit to seed TIME…");
  const usdcContract = new ethers.Contract(
    usdcAddr,
    ["function approve(address,uint) returns(bool)", "function balanceOf(address) view returns(uint)", "function decimals() view returns(uint8)"],
    deployer
  );
  const usdcBalance = await usdcContract.balanceOf(deployer.address);
  const usdcDecimals = await usdcContract.decimals();
  if (usdcBalance === 0n) {
    console.log("       ⚠ Deployer has no USDC — skipping initial deposit and MEMO index init");
    console.log("         Run memo.setIndex(1e9) manually after first stake on live network");
  } else {
    // Deposit: reserve value = 1M TIME. Keep 100K TIME as excess reserves for mintRewards.
    const depositAmount = ethers.parseUnits("1000000", usdcDecimals);
    const excessReserve = ethers.parseUnits("100000", 9); // 100,000 TIME of excess
    await (await usdcContract.approve(treasuryAddr, depositAmount)).wait();
    await (await treasury.deposit(depositAmount, usdcAddr, excessReserve)).wait();
    console.log("       Deposited 1,000,000 USDC → 900,000 TIME minted to deployer");

    // ── MEMO index initialization ───────────────────────────────────────────
    console.log("\n[init] Initializing MEMO index…");
    const currentIndex = await memo.INDEX();
    if (currentIndex === 0n) {
      const oneTime = ethers.parseUnits("1", 9);
      await (await time.approve(stakingHelperAddr, oneTime)).wait();
      await (await stakingHelper.stake(oneTime, deployer.address)).wait();
      await (await memo.setIndex(ethers.parseUnits("1", 9))).wait();
      console.log("       MEMO index set to 1e9");
    } else {
      console.log("       MEMO index already set");
    }
  }

  // ── Step 20: wMEMO ───────────────────────────────────────────────────────
  console.log("\n[ 20 ] Deploying wMEMO…");
  const wmemo = await deploy("wMEMO", [memoAddr]);
  const wmemoAddr = await wmemo.getAddress();

  // ── Save deployment ───────────────────────────────────────────────────────
  Object.assign(deployment, {
    TIME: timeAddr,
    MEMO: memoAddr,
    wMEMO: wmemoAddr,
    BondingCalculator: bondCalcAddr,
    Treasury: treasuryAddr,
    Staking: stakingAddr,
    StakingWarmup: warmupAddr,
    Distributor: distributorAddr,
    StakingHelper: stakingHelperAddr,
    PLSOracle: plsOracleAddr,
    EthBondDepository: ethBondAddr,
    USDCBondDepository: usdcBondAddr,
    USDCLPBondDepository: usdcLpBondAddr || null,
    WPLSLPBondDepository: wplsLpBondAddr || null,
    lpPairTimeUSDC: timeusdcLPAddr || null,
    lpPairTimeWPLS: timewplsLPAddr || null,
  });

  saveDeployment(networkName, deployment);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Deployment complete!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("  TIME             :", timeAddr);
  console.log("  MEMO             :", memoAddr);
  console.log("  wMEMO            :", wmemoAddr);
  console.log("  Treasury         :", treasuryAddr);
  console.log("  Staking          :", stakingAddr);
  console.log("  Distributor      :", distributorAddr);
  console.log("  StakingHelper    :", stakingHelperAddr);
  console.log("  EthBond (WPLS)   :", ethBondAddr);
  console.log("  USDCBond         :", usdcBondAddr);
  console.log("  USDCLPBond       :", usdcLpBondAddr || "not deployed");
  console.log("  WPLSLPBond       :", wplsLpBondAddr || "not deployed");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
