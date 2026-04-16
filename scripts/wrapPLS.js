/**
 * Wraps tPLS → tWPLS on PulseChain testnet.
 * Usage: npx hardhat run scripts/wrapPLS.js --network pulseTestnet
 */
const { ethers, network } = require("hardhat");
const { getConfig } = require("./config");

async function main() {
  const [deployer] = await ethers.getSigners();
  const cfg = getConfig(network.name);

  if (!cfg.wpls) throw new Error("No WPLS address configured for this network.");

  const wplsAbi = [
    "function deposit() external payable",
    "function balanceOf(address) external view returns (uint)",
    "function decimals() external view returns (uint8)",
  ];

  const wpls = new ethers.Contract(cfg.wpls, wplsAbi, deployer);

  const wplsBefore = await wpls.balanceOf(deployer.address);
  const plsBefore  = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  Deployer   : ${deployer.address}`);
  console.log(`  WPLS addr  : ${cfg.wpls}`);
  console.log(`  tPLS before: ${ethers.formatEther(plsBefore)} PLS`);
  console.log(`  WPLS before: ${ethers.formatEther(wplsBefore)} WPLS`);

  const amountToWrap = ethers.parseEther("30"); // wrap 30 tPLS
  console.log(`\n  Wrapping 30 tPLS → tWPLS…`);
  const tx = await deployer.sendTransaction({
    to: cfg.wpls,
    value: amountToWrap,
    data: wpls.interface.encodeFunctionData("deposit"),
  });
  await tx.wait();

  const wplsAfter = await wpls.balanceOf(deployer.address);
  console.log(`  ✓ WPLS after: ${ethers.formatEther(wplsAfter)} WPLS`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
