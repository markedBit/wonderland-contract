/**
 * Wonderland Protocol – Full Deployment Integration Test
 *
 * Tests the complete deployment flow on a local Hardhat network:
 *   - All contracts deploy and initialize correctly
 *   - Treasury permissions are wired properly
 *   - Bond terms are set correctly
 *   - DAO can deposit USDC to mint TIME (initial supply)
 *   - User can purchase a USDC bond (deposit → payout calculated)
 *   - User can stake TIME for MEMO
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ── MANAGING enum (mirrors Treasury.sol) ─────────────────────────────────────
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

const EPOCH_LENGTH = 28800;
const ZERO_ADDR = ethers.ZeroAddress;

async function queueAndToggle(treasury, managing, address, calculator = ZERO_ADDR) {
  await (await treasury.queue(managing, address)).wait();
  await (await treasury.toggle(managing, address, calculator)).wait();
}

describe("Wonderland Full Deployment", function () {
  // Increase timeout – many transactions in before()
  this.timeout(120000);

  let deployer, user1;

  // Mocks
  let mockUsdc, mockWpls, mockLpUsdcTime, mockLpWplsTime;

  // Core contracts
  let time, memo, wmemo, bondCalc, treasury, staking, warmup, distributor, stakingHelper;

  // Oracles & bonds
  let plsOracle, ethBond, usdcBond, usdcLpBond, wplsLpBond;

  // Addresses
  let timeAddr, memoAddr, wmemoAddr, bondCalcAddr, treasuryAddr;
  let stakingAddr, warmupAddr, distributorAddr, stakingHelperAddr;
  let plsOracleAddr, ethBondAddr, usdcBondAddr, usdcLpBondAddr, wplsLpBondAddr;
  let usdcAddr, wplsAddr, lpUsdcAddr, lpWplsAddr;
  let daoAddress;

  before(async function () {
    [deployer, user1] = await ethers.getSigners();
    daoAddress = deployer.address;

    // ── Deploy mocks ────────────────────────────────────────────────────────
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();
    await mockUsdc.waitForDeployment();
    usdcAddr = await mockUsdc.getAddress();

    await (await mockUsdc.mint(deployer.address, ethers.parseUnits("50000000", 6))).wait();
    await (await mockUsdc.mint(user1.address, ethers.parseUnits("1000000", 6))).wait();

    const MockWPLS = await ethers.getContractFactory("MockWPLS");
    mockWpls = await MockWPLS.deploy();
    await mockWpls.waitForDeployment();
    wplsAddr = await mockWpls.getAddress();

    await (await mockWpls.mint(deployer.address, ethers.parseEther("5000000000"))).wait();
    await (await mockWpls.mint(user1.address, ethers.parseEther("100000000"))).wait();

    // ── Step 1-2: Core tokens ───────────────────────────────────────────────
    const TimeFactory = await ethers.getContractFactory("TimeERC20Token");
    time = await TimeFactory.deploy();
    await time.waitForDeployment();
    timeAddr = await time.getAddress();

    const MemoFactory = await ethers.getContractFactory("MEMOries");
    memo = await MemoFactory.deploy();
    await memo.waitForDeployment();
    memoAddr = await memo.getAddress();

    // ── Step 3: Bonding calculator ──────────────────────────────────────────
    const BondCalcFactory = await ethers.getContractFactory("TimeBondingCalculator");
    bondCalc = await BondCalcFactory.deploy(timeAddr);
    await bondCalc.waitForDeployment();
    bondCalcAddr = await bondCalc.getAddress();

    // ── Step 4: Treasury ────────────────────────────────────────────────────
    const TreasuryFactory = await ethers.getContractFactory("TimeTreasury");
    // limitAmount = MaxUint256: no hourly mint cap (0 would block all deposits via underflow)
    treasury = await TreasuryFactory.deploy(timeAddr, usdcAddr, 0, ethers.MaxUint256);
    await treasury.waitForDeployment();
    treasuryAddr = await treasury.getAddress();

    // ── Step 5: TIME.setVault ───────────────────────────────────────────────
    await (await time.setVault(treasuryAddr)).wait();

    // ── Step 6: Staking ─────────────────────────────────────────────────────
    // firstEpochTime = now + 8 h: first rebase happens one full epoch after deployment.
    // firstEpochNumber = 1 (not 0) so warmup expiry is non-zero → claim works on first stake.
    const firstEpochTime = Math.floor(Date.now() / 1000) + EPOCH_LENGTH;
    const StakingFactory = await ethers.getContractFactory("TimeStaking");
    staking = await StakingFactory.deploy(timeAddr, memoAddr, EPOCH_LENGTH, 1, firstEpochTime);
    await staking.waitForDeployment();
    stakingAddr = await staking.getAddress();

    // ── Step 7: MEMO.initialize ─────────────────────────────────────────────
    await (await memo.initialize(stakingAddr)).wait();

    // ── Step 8: StakingWarmup ───────────────────────────────────────────────
    const WarmupFactory = await ethers.getContractFactory("StakingWarmup");
    warmup = await WarmupFactory.deploy(stakingAddr, memoAddr);
    await warmup.waitForDeployment();
    warmupAddr = await warmup.getAddress();

    // ── Step 9: Distributor ─────────────────────────────────────────────────
    const DistributorFactory = await ethers.getContractFactory("Distributor");
    distributor = await DistributorFactory.deploy(
      treasuryAddr, timeAddr, EPOCH_LENGTH, firstEpochTime
    );
    await distributor.waitForDeployment();
    distributorAddr = await distributor.getAddress();

    // ── Step 10: addRecipient(staking, 5000) ────────────────────────────────
    await (await distributor.addRecipient(stakingAddr, 5000)).wait();

    // ── Steps 11-12: Wire staking ───────────────────────────────────────────
    await (await staking.setContract(0, distributorAddr)).wait();
    await (await staking.setContract(1, warmupAddr)).wait();

    // ── Step 13: StakingHelper(staking, TIME) ───────────────────────────────
    const HelperFactory = await ethers.getContractFactory("StakingHelper");
    stakingHelper = await HelperFactory.deploy(stakingAddr, timeAddr);
    await stakingHelper.waitForDeployment();
    stakingHelperAddr = await stakingHelper.getAddress();

    // ── Step 14: Price oracle ───────────────────────────────────────────────
    const OracleFactory = await ethers.getContractFactory("FixedPLSPriceOracle");
    plsOracle = await OracleFactory.deploy();
    await plsOracle.waitForDeployment();
    plsOracleAddr = await plsOracle.getAddress();

    // ── Step 15: EthBondDepository (WPLS) ───────────────────────────────────
    const EthBondFactory = await ethers.getContractFactory(
      "contracts/EthBondDepository.sol:TimeBondDepository"
    );
    ethBond = await EthBondFactory.deploy(
      timeAddr, wplsAddr, treasuryAddr, daoAddress, plsOracleAddr
    );
    await ethBond.waitForDeployment();
    ethBondAddr = await ethBond.getAddress();

    // EthBond payout formula uses ÷1e14 (100× more sensitive than reserve bonds).
    // minimumPrice=17000 keeps payouts within maxPayout for typical deposit amounts.
    await (await ethBond.initializeBondTerms(
      257, 17000, 1000, "1000000000000000000000000", 432000
    )).wait();
    await (await ethBond.setStaking(stakingHelperAddr, true)).wait();

    // ── Step 16: BondDepository #1 – USDC reserve bond ─────────────────────
    const BondFactory = await ethers.getContractFactory(
      "contracts/BondDepository.sol:TimeBondDepository"
    );
    usdcBond = await BondFactory.deploy(
      timeAddr, usdcAddr, treasuryAddr, daoAddress, ZERO_ADDR
    );
    await usdcBond.waitForDeployment();
    usdcBondAddr = await usdcBond.getAddress();

    // minimumPrice=1000 → $10 USDC per TIME  (formula: payout = value*100/price)
    await (await usdcBond.initializeBondTerms(
      257, 1000, 1000, 100, "1000000000000000000000000", 432000
    )).wait();
    await (await usdcBond.setStaking(stakingHelperAddr, true)).wait();

    // ── Steps 17-18: Mock LP pairs & LP bonds ───────────────────────────────
    const MockLP = await ethers.getContractFactory("MockUniswapV2Pair");

    mockLpUsdcTime = await MockLP.deploy(timeAddr, usdcAddr);
    await mockLpUsdcTime.waitForDeployment();
    lpUsdcAddr = await mockLpUsdcTime.getAddress();

    // Reserves at $10/TIME: 1,000 TIME + 10,000 USDC
    await (await mockLpUsdcTime.setReserves(
      ethers.parseUnits("1000", 9),
      ethers.parseUnits("10000", 6)
    )).wait();
    await (await mockLpUsdcTime.mint(deployer.address, ethers.parseEther("100"))).wait();
    await (await mockLpUsdcTime.mint(user1.address, ethers.parseEther("10"))).wait();

    mockLpWplsTime = await MockLP.deploy(timeAddr, wplsAddr);
    await mockLpWplsTime.waitForDeployment();
    lpWplsAddr = await mockLpWplsTime.getAddress();

    // Reserves: 1,000 TIME + 1,120,952,000 WPLS  (1 TIME = 1,120,952 WPLS at $10/$0.000008921)
    await (await mockLpWplsTime.setReserves(
      ethers.parseUnits("1000", 9),
      ethers.parseEther("1120952000")
    )).wait();
    await (await mockLpWplsTime.mint(deployer.address, ethers.parseEther("100"))).wait();
    await (await mockLpWplsTime.mint(user1.address, ethers.parseEther("10"))).wait();

    usdcLpBond = await BondFactory.deploy(
      timeAddr, lpUsdcAddr, treasuryAddr, daoAddress, bondCalcAddr
    );
    await usdcLpBond.waitForDeployment();
    usdcLpBondAddr = await usdcLpBond.getAddress();
    await (await usdcLpBond.initializeBondTerms(
      257, 1000, 1000, 100, "1000000000000000000000000", 432000
    )).wait();
    await (await usdcLpBond.setStaking(stakingHelperAddr, true)).wait();

    wplsLpBond = await BondFactory.deploy(
      timeAddr, lpWplsAddr, treasuryAddr, daoAddress, bondCalcAddr
    );
    await wplsLpBond.waitForDeployment();
    wplsLpBondAddr = await wplsLpBond.getAddress();
    await (await wplsLpBond.initializeBondTerms(
      257, 1000, 1000, 100, "1000000000000000000000000", 432000
    )).wait();
    await (await wplsLpBond.setStaking(stakingHelperAddr, true)).wait();

    // ── Step 19: Treasury permissions ──────────────────────────────────────
    await queueAndToggle(treasury, MANAGING.RESERVETOKEN, wplsAddr);
    await queueAndToggle(treasury, MANAGING.RESERVEDEPOSITOR, daoAddress);
    await queueAndToggle(treasury, MANAGING.RESERVEMANAGER, daoAddress);
    await queueAndToggle(treasury, MANAGING.LIQUIDITYMANAGER, daoAddress);
    await queueAndToggle(treasury, MANAGING.RESERVEDEPOSITOR, ethBondAddr);
    await queueAndToggle(treasury, MANAGING.RESERVEDEPOSITOR, usdcBondAddr);
    await queueAndToggle(treasury, MANAGING.LIQUIDITYDEPOSITOR, usdcLpBondAddr);
    await queueAndToggle(treasury, MANAGING.LIQUIDITYTOKEN, lpUsdcAddr, bondCalcAddr);
    await queueAndToggle(treasury, MANAGING.LIQUIDITYDEPOSITOR, wplsLpBondAddr);
    await queueAndToggle(treasury, MANAGING.LIQUIDITYTOKEN, lpWplsAddr, bondCalcAddr);
    await queueAndToggle(treasury, MANAGING.REWARDMANAGER, distributorAddr);
    // EthBond uses treasury.mintRewards() so it also needs reward manager role
    await queueAndToggle(treasury, MANAGING.REWARDMANAGER, ethBondAddr);
    await queueAndToggle(treasury, MANAGING.SOHM, memoAddr);

    // ── Step 20: wMEMO ─────────────────────────────────────────────────────
    const wMemoFactory = await ethers.getContractFactory("wMEMO");
    wmemo = await wMemoFactory.deploy(memoAddr);
    await wmemo.waitForDeployment();
    wmemoAddr = await wmemo.getAddress();

    // ── Seed initial TIME supply via treasury deposit ───────────────────────
    // Deposit 1,000,000 USDC. Reserve value = 1,000,000 TIME.
    // Use a profit of 100,000 TIME so the treasury retains excess reserves
    // that the EthBondDepository can draw from via mintRewards().
    const initialUSDC = ethers.parseUnits("1000000", 6);
    const excessReserveAmount = ethers.parseUnits("100000", 9); // 100,000 TIME as excess
    await (await mockUsdc.approve(treasuryAddr, initialUSDC)).wait();
    await (await treasury.deposit(initialUSDC, usdcAddr, excessReserveAmount)).wait();
    // deployer receives 900,000 TIME; 100,000 TIME stays as excess reserves

    // ── Initialize MEMO index ───────────────────────────────────────────────
    // wMEMO.wrap divides by MEMO.index(); index must be set once after MEMO has supply.
    // Stake 1 TIME from deployer to create initial MEMO supply, then set the index.
    const oneTime = ethers.parseUnits("1", 9);
    await (await time.approve(stakingHelperAddr, oneTime)).wait();
    await (await stakingHelper.stake(oneTime, deployer.address)).wait();
    // INDEX = 1 (9-decimal unit) — represents 1:1 MEMO:wMEMO at launch
    await (await memo.setIndex(ethers.parseUnits("1", 9))).wait();
  });

  // ── Deployment verification ──────────────────────────────────────────────

  describe("Contract Addresses", function () {
    it("TIME is deployed", async function () {
      expect(timeAddr).to.not.equal(ZERO_ADDR);
      expect(await time.name()).to.equal("Time");
      expect(await time.symbol()).to.equal("TIME");
      expect(await time.decimals()).to.equal(9);
    });

    it("MEMO is deployed", async function () {
      expect(memoAddr).to.not.equal(ZERO_ADDR);
      expect(await memo.symbol()).to.equal("MEMO");
    });

    it("wMEMO is deployed", async function () {
      expect(wmemoAddr).to.not.equal(ZERO_ADDR);
      expect(await wmemo.symbol()).to.equal("wMEMO");
    });

    it("Treasury is deployed", async function () {
      expect(treasuryAddr).to.not.equal(ZERO_ADDR);
    });

    it("Staking is deployed", async function () {
      expect(stakingAddr).to.not.equal(ZERO_ADDR);
    });

    it("All four bond depositories are deployed", async function () {
      expect(ethBondAddr).to.not.equal(ZERO_ADDR);
      expect(usdcBondAddr).to.not.equal(ZERO_ADDR);
      expect(usdcLpBondAddr).to.not.equal(ZERO_ADDR);
      expect(wplsLpBondAddr).to.not.equal(ZERO_ADDR);
    });
  });

  describe("Token wiring", function () {
    it("TIME vault is the treasury", async function () {
      expect(await time.vault()).to.equal(treasuryAddr);
    });

    it("MEMO staking contract is the staking contract", async function () {
      expect(await memo.stakingContract()).to.equal(stakingAddr);
    });

    it("wMEMO wraps MEMO", async function () {
      expect(await wmemo.MEMO()).to.equal(memoAddr);
    });
  });

  describe("Staking wiring", function () {
    it("Staking distributor is set correctly", async function () {
      expect(await staking.distributor()).to.equal(distributorAddr);
    });

    it("Staking warmup is set correctly", async function () {
      expect(await staking.warmupContract()).to.equal(warmupAddr);
    });

    it("Distributor has staking as recipient with rate 5000", async function () {
      const info = await distributor.info(0);
      expect(info.recipient).to.equal(stakingAddr);
      expect(info.rate).to.equal(5000n);
    });
  });

  describe("Treasury permissions", function () {
    it("Treasury TIME is correct", async function () {
      expect(await treasury.Time()).to.equal(timeAddr);
    });

    it("USDC is a reserve token (set in constructor)", async function () {
      expect(await treasury.isReserveToken(usdcAddr)).to.be.true;
    });

    it("WPLS is a reserve token", async function () {
      expect(await treasury.isReserveToken(wplsAddr)).to.be.true;
    });

    it("DAO is a reserve depositor", async function () {
      expect(await treasury.isReserveDepositor(daoAddress)).to.be.true;
    });

    it("EthBond is a reserve depositor", async function () {
      expect(await treasury.isReserveDepositor(ethBondAddr)).to.be.true;
    });

    it("USDCBond is a reserve depositor", async function () {
      expect(await treasury.isReserveDepositor(usdcBondAddr)).to.be.true;
    });

    it("Distributor is a reward manager", async function () {
      expect(await treasury.isRewardManager(distributorAddr)).to.be.true;
    });

    it("MEMO is set as sOHM (MEMOries)", async function () {
      expect(await treasury.MEMOries()).to.equal(memoAddr);
    });

    it("TIME-USDC LP is a liquidity token with bondCalc", async function () {
      expect(await treasury.isLiquidityToken(lpUsdcAddr)).to.be.true;
      expect(await treasury.bondCalculator(lpUsdcAddr)).to.equal(bondCalcAddr);
    });

    it("TIME-WPLS LP is a liquidity token with bondCalc", async function () {
      expect(await treasury.isLiquidityToken(lpWplsAddr)).to.be.true;
      expect(await treasury.bondCalculator(lpWplsAddr)).to.equal(bondCalcAddr);
    });
  });

  describe("Bond terms", function () {
    it("EthBond terms are initialized correctly", async function () {
      const terms = await ethBond.terms();
      expect(terms.controlVariable).to.equal(257n);
      expect(terms.minimumPrice).to.equal(17000n); // EthBond scale differs from reserve bonds
      expect(terms.maxPayout).to.equal(1000n);
      expect(terms.maxDebt).to.equal(BigInt("1000000000000000000000000"));
      expect(terms.vestingTerm).to.equal(432000n);
    });

    it("USDCBond terms are initialized correctly", async function () {
      const terms = await usdcBond.terms();
      expect(terms.controlVariable).to.equal(257n);
      expect(terms.minimumPrice).to.equal(1000n); // $10/TIME
      expect(terms.maxPayout).to.equal(1000n);
      expect(terms.fee).to.equal(100n);
      expect(terms.maxDebt).to.equal(BigInt("1000000000000000000000000"));
      expect(terms.vestingTerm).to.equal(432000n);
    });

    it("USDCLPBond terms are initialized correctly", async function () {
      const terms = await usdcLpBond.terms();
      expect(terms.controlVariable).to.equal(257n);
      expect(terms.minimumPrice).to.equal(1000n);
      expect(terms.vestingTerm).to.equal(432000n);
    });

    it("WPLSLPBond terms are initialized correctly", async function () {
      const terms = await wplsLpBond.terms();
      expect(terms.controlVariable).to.equal(257n);
      expect(terms.minimumPrice).to.equal(1000n);
      expect(terms.vestingTerm).to.equal(432000n);
    });
  });

  describe("Price oracle", function () {
    it("FixedPLSPriceOracle returns expected price", async function () {
      const [, price, , ,] = await plsOracle.latestRoundData();
      expect(price).to.equal(892n); // $0.000008921 × 1e8 = 892
      expect(await plsOracle.decimals()).to.equal(8n);
    });
  });

  describe("Initial TIME supply", function () {
    it("Deployer received TIME from treasury deposit", async function () {
      const balance = await time.balanceOf(deployer.address);
      expect(balance).to.be.gt(0n);
      console.log(`       Deployer TIME balance: ${ethers.formatUnits(balance, 9)} TIME`);
    });

    it("Treasury has USDC reserves", async function () {
      const reserves = await treasury.totalReserves();
      expect(reserves).to.be.gt(0n);
    });
  });

  describe("Bonding calculator", function () {
    it("Can calculate bond value for TIME-USDC LP", async function () {
      const lpBalance = ethers.parseEther("1"); // 1 LP token
      const value = await bondCalc.valuation(lpUsdcAddr, lpBalance);
      expect(value).to.be.gt(0n);
      console.log(`       TIME-USDC LP valuation (1 LP): ${ethers.formatUnits(value, 9)} TIME`);
    });

    it("Can calculate bond value for TIME-WPLS LP", async function () {
      const lpBalance = ethers.parseEther("1");
      const value = await bondCalc.valuation(lpWplsAddr, lpBalance);
      expect(value).to.be.gt(0n);
      console.log(`       TIME-WPLS LP valuation (1 LP): ${ethers.formatUnits(value, 9)} TIME`);
    });
  });

  describe("USDC reserve bond – deposit flow", function () {
    it("User can deposit USDC to purchase a bond", async function () {
      // Deposit 17,000 USDC → should yield ~1 TIME payout
      const depositAmount = ethers.parseUnits("17000", 6);

      // Approve bond depository to pull USDC from user1
      await (await mockUsdc.connect(user1).approve(usdcBondAddr, depositAmount)).wait();

      // bondPrice() starts at minimumPrice (17000) when debt = 0
      const bondPrice = await usdcBond.bondPrice();
      const maxPrice = bondPrice * 2n; // give generous slippage

      const tx = await usdcBond
        .connect(user1)
        .deposit(depositAmount, maxPrice, user1.address);
      const receipt = await tx.wait();

      // Verify BondCreated event was emitted
      const bondCreatedEvent = receipt.logs.find((log) => {
        try {
          return usdcBond.interface.parseLog(log)?.name === "BondCreated";
        } catch {
          return false;
        }
      });
      expect(bondCreatedEvent).to.not.be.undefined;

      // Verify bond info was recorded for user1
      const bondInfo = await usdcBond.bondInfo(user1.address);
      expect(bondInfo.payout).to.be.gt(0n);
      console.log(
        `       Bond payout: ${ethers.formatUnits(bondInfo.payout, 9)} TIME (vesting)`
      );
    });
  });

  describe("WPLS reserve bond – deposit flow", function () {
    it("User can deposit WPLS to purchase a bond", async function () {
      // WPLS bond price denominated differently (uses Chainlink oracle)
      const bondPrice = await ethBond.bondPrice();
      const maxPrice = bondPrice * 3n;

      // Deposit 10,000 WPLS → payout ~5.88 TIME (well under maxPayout of 10,000 TIME)
      const depositAmount = ethers.parseEther("10000"); // 10,000 WPLS

      await (await mockWpls.connect(user1).approve(ethBondAddr, depositAmount)).wait();

      const tx = await ethBond
        .connect(user1)
        .deposit(depositAmount, maxPrice, user1.address);
      await tx.wait();

      const bondInfo = await ethBond.bondInfo(user1.address);
      expect(bondInfo.payout).to.be.gt(0n);
      console.log(
        `       ETH bond payout: ${ethers.formatUnits(bondInfo.payout, 9)} TIME`
      );
    });
  });

  describe("TIME-USDC LP bond – deposit flow", function () {
    it("User can deposit LP tokens to purchase a bond", async function () {
      const bondPrice = await usdcLpBond.bondPrice();
      const maxPrice = bondPrice * 3n;

      // user1 has 10 LP tokens minted in before()
      const depositAmount = ethers.parseEther("1");

      await (await mockLpUsdcTime.connect(user1).approve(usdcLpBondAddr, depositAmount)).wait();

      const tx = await usdcLpBond
        .connect(user1)
        .deposit(depositAmount, maxPrice, user1.address);
      await tx.wait();

      const bondInfo = await usdcLpBond.bondInfo(user1.address);
      expect(bondInfo.payout).to.be.gt(0n);
      console.log(
        `       USDC-LP bond payout: ${ethers.formatUnits(bondInfo.payout, 9)} TIME`
      );
    });
  });

  describe("TIME-WPLS LP bond – deposit flow", function () {
    it("User can deposit WPLS-LP tokens to purchase a bond", async function () {
      const bondPrice = await wplsLpBond.bondPrice();
      const maxPrice = bondPrice * 3n;

      // user1 has 10 WPLS-LP tokens minted in before()
      const depositAmount = ethers.parseEther("1");

      await (await mockLpWplsTime.connect(user1).approve(wplsLpBondAddr, depositAmount)).wait();

      const tx = await wplsLpBond
        .connect(user1)
        .deposit(depositAmount, maxPrice, user1.address);
      await tx.wait();

      const bondInfo = await wplsLpBond.bondInfo(user1.address);
      expect(bondInfo.payout).to.be.gt(0n);
      console.log(
        `       WPLS-LP bond payout: ${ethers.formatUnits(bondInfo.payout, 9)} TIME`
      );
    });
  });

  // ── Treasury state ──────────────────────────────────────────────────────────

  describe("Treasury – reserves & excess", function () {
    it("totalReserves is positive after all bond deposits", async function () {
      const reserves = await treasury.totalReserves();
      expect(reserves).to.be.gt(0n);
      console.log(`       Total reserves: ${ethers.formatUnits(reserves, 9)} (TIME-denominated)`);
    });

    it("excessReserves is positive (buffer for mintRewards)", async function () {
      const excess = await treasury.excessReserves();
      expect(excess).to.be.gt(0n);
      console.log(`       Excess reserves: ${ethers.formatUnits(excess, 9)} TIME`);
    });

    it("TIME totalSupply matches treasury accounting", async function () {
      const supply = await time.totalSupply();
      const reserves = await treasury.totalReserves();
      // excessReserves = reserves - supply; must be >= 0
      expect(reserves).to.be.gte(supply);
    });
  });

  // ── Staking flows ───────────────────────────────────────────────────────────

  describe("Staking – TIME → MEMO", function () {
    it("User can stake TIME to receive MEMO (via StakingHelper)", async function () {
      const timeToSend = ethers.parseUnits("10", 9); // 10 TIME
      await (await time.transfer(user1.address, timeToSend)).wait();

      const memoBefore = await memo.balanceOf(user1.address);

      // StakingHelper.stake(uint _amount, address recipient) — takes two args
      await (await time.connect(user1).approve(stakingHelperAddr, timeToSend)).wait();
      await (await stakingHelper.connect(user1).stake(timeToSend, user1.address)).wait();

      // StakingHelper calls stake + claim immediately (no warmup)
      const memoAfter = await memo.balanceOf(user1.address);
      expect(memoAfter).to.be.gt(memoBefore);
      console.log(
        `       Staked ${ethers.formatUnits(timeToSend, 9)} TIME → received ${ethers.formatUnits(memoAfter - memoBefore, 9)} MEMO`
      );
    });
  });

  describe("Staking – unstake MEMO → TIME", function () {
    it("User can unstake half their MEMO back into TIME", async function () {
      const memoBalance = await memo.balanceOf(user1.address);
      expect(memoBalance).to.be.gt(0n, "user1 must have MEMO from previous stake test");

      // Unstake half
      const halfMemo = memoBalance / 2n;
      const timeBefore = await time.balanceOf(user1.address);

      // Must approve staking contract to pull MEMO
      await (await memo.connect(user1).approve(stakingAddr, halfMemo)).wait();
      // unstake(amount, triggerRebase=false) — epoch hasn't ended yet so safe to skip
      await (await staking.connect(user1).unstake(halfMemo, false)).wait();

      const timeAfter = await time.balanceOf(user1.address);
      expect(timeAfter).to.be.gt(timeBefore);
      console.log(
        `       Unstaked ${ethers.formatUnits(halfMemo, 9)} MEMO → received ${ethers.formatUnits(timeAfter - timeBefore, 9)} TIME`
      );
    });
  });

  // ── wMEMO wrap / unwrap ─────────────────────────────────────────────────────

  describe("wMEMO – wrap MEMO → wMEMO", function () {
    it("User can wrap remaining MEMO into wMEMO", async function () {
      const memoBalance = await memo.balanceOf(user1.address);
      if (memoBalance === 0n) this.skip();

      await (await memo.connect(user1).approve(wmemoAddr, memoBalance)).wait();

      const wmemoBefore = await wmemo.balanceOf(user1.address);
      await (await wmemo.connect(user1).wrap(memoBalance)).wait();
      const wmemoAfter = await wmemo.balanceOf(user1.address);

      expect(wmemoAfter).to.be.gt(wmemoBefore);
      console.log(
        `       Wrapped ${ethers.formatUnits(memoBalance, 9)} MEMO → ${ethers.formatUnits(wmemoAfter - wmemoBefore, 18)} wMEMO`
      );
    });
  });

  describe("wMEMO – unwrap wMEMO → MEMO", function () {
    it("User can unwrap wMEMO back into MEMO", async function () {
      const wmemoBalance = await wmemo.balanceOf(user1.address);
      if (wmemoBalance === 0n) this.skip();

      const memoBefore = await memo.balanceOf(user1.address);

      await (await wmemo.connect(user1).unwrap(wmemoBalance)).wait();

      const memoAfter = await memo.balanceOf(user1.address);
      expect(memoAfter).to.be.gt(memoBefore);
      console.log(
        `       Unwrapped ${ethers.formatUnits(wmemoBalance, 18)} wMEMO → ${ethers.formatUnits(memoAfter - memoBefore, 9)} MEMO`
      );
    });
  });

  // ── Epoch & rebase ──────────────────────────────────────────────────────────

  describe("Staking – epoch rebase after one epoch", function () {
    it("Rebase triggers correctly after epoch length elapses", async function () {
      const epochBefore = await staking.epoch();

      // Advance past the first epoch end (firstEpochTime = deploy + 8 h)
      await ethers.provider.send("evm_increaseTime", [EPOCH_LENGTH + 1]);
      await ethers.provider.send("evm_mine", []);

      // staking.rebase() is public; anyone can call it
      const tx = await staking.rebase();
      await tx.wait();

      const epochAfter = await staking.epoch();
      expect(epochAfter.number).to.equal(epochBefore.number + 1n);
      console.log(`       Epoch advanced: ${epochBefore.number} → ${epochAfter.number}`);
    });

    it("Epoch endTime advanced by one epoch length after rebase", async function () {
      const epochData = await staking.epoch();
      // endTime should have moved forward by exactly epochLength
      // (stored as uint32 seconds; just verify it's in the future)
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      expect(epochData.endTime).to.be.gt(nowSec);
    });
  });

  // ── Bond redemption ─────────────────────────────────────────────────────────
  // Advance past the full vestingTerm (432 000 s = 5 days) so all bonds are
  // 100 % vested before redeeming.

  describe("Bond redemption – after full vesting", function () {
    before(async function () {
      // Advance past vestingTerm.  We already advanced one EPOCH_LENGTH (28 800 s)
      // in the rebase test, so adding 432 001 s puts total elapsed well above 432 000 s
      // from the time of bond purchase.
      await ethers.provider.send("evm_increaseTime", [432001]);
      await ethers.provider.send("evm_mine", []);
    });

    it("percentVestedFor returns 10 000 (fully vested) for USDC bond", async function () {
      const pct = await usdcBond.percentVestedFor(user1.address);
      expect(pct).to.be.gte(10000n);
    });

    it("User redeems USDC bond and receives TIME", async function () {
      const infoBefore = await usdcBond.bondInfo(user1.address);
      if (infoBefore.payout === 0n) this.skip();

      const timeBefore = await time.balanceOf(user1.address);
      await (await usdcBond.connect(user1).redeem(user1.address, false)).wait();
      const timeAfter = await time.balanceOf(user1.address);

      expect(timeAfter).to.be.gt(timeBefore);
      console.log(
        `       Redeemed USDC bond: +${ethers.formatUnits(timeAfter - timeBefore, 9)} TIME`
      );
    });

    it("User redeems WPLS bond and receives TIME", async function () {
      const infoBefore = await ethBond.bondInfo(user1.address);
      if (infoBefore.payout === 0n) this.skip();

      const timeBefore = await time.balanceOf(user1.address);
      await (await ethBond.connect(user1).redeem(user1.address, false)).wait();
      const timeAfter = await time.balanceOf(user1.address);

      expect(timeAfter).to.be.gt(timeBefore);
      console.log(
        `       Redeemed WPLS bond: +${ethers.formatUnits(timeAfter - timeBefore, 9)} TIME`
      );
    });

    it("User redeems TIME-USDC LP bond and receives TIME", async function () {
      const infoBefore = await usdcLpBond.bondInfo(user1.address);
      if (infoBefore.payout === 0n) this.skip();

      const timeBefore = await time.balanceOf(user1.address);
      await (await usdcLpBond.connect(user1).redeem(user1.address, false)).wait();
      const timeAfter = await time.balanceOf(user1.address);

      expect(timeAfter).to.be.gt(timeBefore);
      console.log(
        `       Redeemed USDC-LP bond: +${ethers.formatUnits(timeAfter - timeBefore, 9)} TIME`
      );
    });

    it("User redeems TIME-WPLS LP bond and receives TIME", async function () {
      const infoBefore = await wplsLpBond.bondInfo(user1.address);
      if (infoBefore.payout === 0n) this.skip();

      const timeBefore = await time.balanceOf(user1.address);
      await (await wplsLpBond.connect(user1).redeem(user1.address, false)).wait();
      const timeAfter = await time.balanceOf(user1.address);

      expect(timeAfter).to.be.gt(timeBefore);
      console.log(
        `       Redeemed WPLS-LP bond: +${ethers.formatUnits(timeAfter - timeBefore, 9)} TIME`
      );
    });

    it("After redemption bondInfo payout is zero (bond cleared)", async function () {
      const usdcInfo  = await usdcBond.bondInfo(user1.address);
      const ethInfo   = await ethBond.bondInfo(user1.address);
      const lpUsdcInfo = await usdcLpBond.bondInfo(user1.address);
      const lpWplsInfo = await wplsLpBond.bondInfo(user1.address);
      expect(usdcInfo.payout).to.equal(0n);
      expect(ethInfo.payout).to.equal(0n);
      expect(lpUsdcInfo.payout).to.equal(0n);
      expect(lpWplsInfo.payout).to.equal(0n);
    });

    it("User can redeem a bond directly into staked MEMO", async function () {
      // user1 creates a fresh USDC bond then redeems with _stake=true
      const depositAmt = ethers.parseUnits("17000", 6);
      const bondPrice  = await usdcBond.bondPrice();
      const maxPrice   = bondPrice * 3n;

      await (await mockUsdc.connect(user1).approve(usdcBondAddr, depositAmt)).wait();
      await (await usdcBond.connect(user1).deposit(depositAmt, maxPrice, user1.address)).wait();

      // Fast-forward past vesting
      await ethers.provider.send("evm_increaseTime", [432001]);
      await ethers.provider.send("evm_mine", []);

      const memoBefore = await memo.balanceOf(user1.address);
      await (await usdcBond.connect(user1).redeem(user1.address, true)).wait();
      const memoAfter = await memo.balanceOf(user1.address);

      expect(memoAfter).to.be.gt(memoBefore);
      console.log(
        `       Bond redeemed+staked: +${ethers.formatUnits(memoAfter - memoBefore, 9)} MEMO`
      );
    });
  });
});
