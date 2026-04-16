/**
 * Wonderland Protocol – LP Pair Creation & LP Bond Deployment
 *
 * This script:
 *   1. Reads the existing deployment file (created by deploy.js)
 *   2. Creates TIME-USDC and TIME-WPLS LP pairs via PulseX router
 *   3. Deploys BondDepository #2 (TIME-USDC LP) and #3 (TIME-WPLS LP)
 *   4. Wires LP bonds into the treasury
 *   5. Updates the deployment file with LP addresses
 *
 * Prerequisites:
 *   - deploy.js must have run first (deployments/<network>.json must exist)
 *   - Deployer must hold sufficient TIME, USDC, and WPLS for initial liquidity
 *   - On testnet: mint TIME via treasury.deposit first, then run this script
 *
 * Usage:
 *   npx hardhat run scripts/deployLP.js --network pulseTestnet
 *   npx hardhat run scripts/deployLP.js --network pulse
 */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { getConfig } = require("./config");

// ── PulseX Router ABI (only what we need) ────────────────────────────────────
const ROUTER_ABI = [
  "function factory() external pure returns (address)",
  "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB, uint liquidity)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];

const ERC20_ABI = [
  "function approve(address spender, uint amount) external returns (bool)",
  "function balanceOf(address owner) external view returns (uint)",
  "function decimals() external view returns (uint8)",
];

// ── Network config ────────────────────────────────────────────────────────────
const { DAO_ADDRESS } = require("./config");

function getRouterAddress(networkName) {
  const cfg = getConfig(networkName);
  if (!cfg.router) throw new Error(`No router configured for network: ${networkName}`);
  return cfg.router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadDeployment(networkName) {
  const file = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Deployment file not found: ${file}\nRun deploy.js first.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveDeployment(networkName, data) {
  const dir = path.join(__dirname, "..", "deployments");
  const file = path.join(dir, `${networkName}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\n  Deployment updated → deployments/${networkName}.json`);
}

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

const MANAGING = {
  RESERVEDEPOSITOR: 0,
  LIQUIDITYDEPOSITOR: 4,
  LIQUIDITYTOKEN: 5,
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const networkName = network.name;

  if (networkName === "hardhat" || networkName === "localhost") {
    console.log("⚠ This script is intended for live networks.");
    console.log("  LP pairs on local networks are handled by deploy.js automatically.");
    process.exit(0);
  }

  const [deployer] = await ethers.getSigners();
  const daoAddress = DAO_ADDRESS;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  LP Deployment`);
  console.log(`  Network  : ${networkName}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const dep = loadDeployment(networkName);
  const timeAddr = dep.TIME;
  const usdcAddr = dep.usdc || dep.mockUSDC;
  const wplsAddr = dep.wpls;
  const bondCalcAddr = dep.BondingCalculator;
  const treasuryAddr = dep.Treasury;
  const stakingHelperAddr = dep.StakingHelper;

  if (!timeAddr || !usdcAddr || !wplsAddr) {
    throw new Error("Missing TIME, USDC, or WPLS address in deployment file.");
  }

  const routerAddr = getRouterAddress(networkName);
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, deployer);
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, deployer);

  const timeToken = new ethers.Contract(timeAddr, ERC20_ABI, deployer);
  const usdcToken = new ethers.Contract(usdcAddr, ERC20_ABI, deployer);
  const wplsToken = new ethers.Contract(wplsAddr, ERC20_ABI, deployer);

  // ── Resolve LP amounts from config ───────────────────────────────────────
  const cfg = getConfig(networkName);
  if (!cfg.lp) {
    throw new Error(`No LP amounts configured for network "${networkName}". Add a lp: { ... } entry to scripts/config.js.`);
  }

  const timeForUsdc = ethers.parseUnits(cfg.lp.timeUsdc.time, 9);
  const usdcForPair = ethers.parseUnits(cfg.lp.timeUsdc.usdc, 6);
  const timeForWpls = ethers.parseUnits(cfg.lp.timeWpls.time, 9);
  const wplsForPair = ethers.parseEther(cfg.lp.timeWpls.wpls);

  // ── Pre-flight balance checks ─────────────────────────────────────────────
  const timeBalance = await timeToken.balanceOf(deployer.address);
  const usdcBalance = await usdcToken.balanceOf(deployer.address);
  const wplsBalance = await wplsToken.balanceOf(deployer.address);
  const timeNeeded  = timeForUsdc + timeForWpls;

  console.log(`  TIME balance : ${ethers.formatUnits(timeBalance, 9)} TIME  (need ${ethers.formatUnits(timeNeeded, 9)})`);
  console.log(`  USDC balance : ${ethers.formatUnits(usdcBalance, 6)} USDC  (need ${ethers.formatUnits(usdcForPair, 6)})`);
  console.log(`  WPLS balance : ${ethers.formatUnits(wplsBalance, 18)} WPLS  (need ${ethers.formatUnits(wplsForPair, 18)})`);

  if (timeBalance < timeNeeded) {
    throw new Error(
      `Insufficient TIME. Have ${ethers.formatUnits(timeBalance, 9)}, need ${ethers.formatUnits(timeNeeded, 9)}.\n` +
      "Deposit USDC into the treasury to mint TIME first."
    );
  }
  if (usdcBalance < usdcForPair) {
    throw new Error(
      `Insufficient USDC. Have ${ethers.formatUnits(usdcBalance, 6)}, need ${ethers.formatUnits(usdcForPair, 6)}.`
    );
  }
  if (wplsBalance < wplsForPair) {
    throw new Error(
      `Insufficient WPLS. Have ${ethers.formatUnits(wplsBalance, 18)}, need ${ethers.formatUnits(wplsForPair, 18)}.\n` +
      "Wrap tPLS → WPLS: call WPLS.deposit{value: amount}() on the WPLS contract."
    );
  }

  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  // ── Create TIME-USDC LP pair ──────────────────────────────────────────────
  console.log(`\n[ 1 ] Creating TIME-USDC LP pair (${ethers.formatUnits(timeForUsdc, 9)} TIME + ${ethers.formatUnits(usdcForPair, 6)} USDC)…`);

  await (await timeToken.approve(routerAddr, timeForUsdc)).wait();
  await (await usdcToken.approve(routerAddr, usdcForPair)).wait();

  await (
    await router.addLiquidity(
      timeAddr,
      usdcAddr,
      timeForUsdc,
      usdcForPair,
      0, // amountAMin (no slippage protection for initial liquidity)
      0, // amountBMin
      deployer.address,
      deadline
    )
  ).wait();

  const timeusdcLPAddr = await factory.getPair(timeAddr, usdcAddr);
  console.log(`  ✓ TIME-USDC LP pair: ${timeusdcLPAddr}`);

  // ── Create TIME-WPLS LP pair ──────────────────────────────────────────────
  console.log(`\n[ 2 ] Creating TIME-WPLS LP pair (${ethers.formatUnits(timeForWpls, 9)} TIME + ${ethers.formatUnits(wplsForPair, 18)} WPLS)…`);

  await (await timeToken.approve(routerAddr, timeForWpls)).wait();
  await (await wplsToken.approve(routerAddr, wplsForPair)).wait();

  await (
    await router.addLiquidity(
      timeAddr,
      wplsAddr,
      timeForWpls,
      wplsForPair,
      0,
      0,
      deployer.address,
      deadline
    )
  ).wait();

  const timewplsLPAddr = await factory.getPair(timeAddr, wplsAddr);
  console.log(`  ✓ TIME-WPLS LP pair: ${timewplsLPAddr}`);

  // ── Deploy BondDepository #2 – TIME-USDC LP ───────────────────────────────
  console.log("\n[ 3 ] Deploying BondDepository #2 (TIME-USDC LP bond)…");
  const usdcLpBond = await deploy("contracts/BondDepository.sol:TimeBondDepository", [
    timeAddr,
    timeusdcLPAddr,
    treasuryAddr,
    daoAddress,
    bondCalcAddr,
  ], "BondDepository(TIME-USDC LP)");
  const usdcLpBondAddr = await usdcLpBond.getAddress();

  // minimumPrice=1000 → $10/TIME starting price  (formula: price = minimumPrice / 100)
  await (await usdcLpBond.initializeBondTerms(
    257, 1000, 1000, 100, "1000000000000000000000000", 432000
  )).wait();
  await (await usdcLpBond.setStaking(stakingHelperAddr, true)).wait();
  console.log("       Bond terms initialized");

  // ── Deploy BondDepository #3 – TIME-WPLS LP ───────────────────────────────
  console.log("\n[ 4 ] Deploying BondDepository #3 (TIME-WPLS LP bond)…");
  const wplsLpBond = await deploy("contracts/BondDepository.sol:TimeBondDepository", [
    timeAddr,
    timewplsLPAddr,
    treasuryAddr,
    daoAddress,
    bondCalcAddr,
  ], "BondDepository(TIME-WPLS LP)");
  const wplsLpBondAddr = await wplsLpBond.getAddress();

  await (await wplsLpBond.initializeBondTerms(
    257, 1000, 1000, 100, "1000000000000000000000000", 432000
  )).wait();
  await (await wplsLpBond.setStaking(stakingHelperAddr, true)).wait();
  console.log("       Bond terms initialized");

  // ── Wire LP bonds into treasury ───────────────────────────────────────────
  console.log("\n[ 5 ] Wiring LP bonds into treasury…");
  const treasury = await ethers.getContractAt("TimeTreasury", treasuryAddr);

  await queueAndToggle(treasury, MANAGING.LIQUIDITYDEPOSITOR, usdcLpBondAddr);
  console.log("       ✓ USDCLPBond → liquidity depositor");

  await queueAndToggle(treasury, MANAGING.LIQUIDITYTOKEN, timeusdcLPAddr, bondCalcAddr);
  console.log("       ✓ TIME-USDC LP → liquidity token");

  await queueAndToggle(treasury, MANAGING.LIQUIDITYDEPOSITOR, wplsLpBondAddr);
  console.log("       ✓ WPLSLPBond → liquidity depositor");

  await queueAndToggle(treasury, MANAGING.LIQUIDITYTOKEN, timewplsLPAddr, bondCalcAddr);
  console.log("       ✓ TIME-WPLS LP → liquidity token");

  // ── Update deployment file ────────────────────────────────────────────────
  dep.lpPairTimeUSDC = timeusdcLPAddr;
  dep.lpPairTimeWPLS = timewplsLPAddr;
  dep.USDCLPBondDepository = usdcLpBondAddr;
  dep.WPLSLPBondDepository = wplsLpBondAddr;
  saveDeployment(networkName, dep);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LP Deployment complete!");
  console.log("  TIME-USDC LP    :", timeusdcLPAddr);
  console.log("  TIME-WPLS LP    :", timewplsLPAddr);
  console.log("  USDCLPBond      :", usdcLpBondAddr);
  console.log("  WPLSLPBond      :", wplsLpBondAddr);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
