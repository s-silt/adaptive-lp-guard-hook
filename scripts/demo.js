const { ethers } = require("hardhat");

const baseConfig = {
  minFeeBps: 5,
  baseFeeBps: 30,
  maxFeeBps: 300,
  volatilityThresholdTicks: 50,
  volatilityFeeBps: 50,
  volatilitySlopeDivisor: 3,
  largeSwapThreshold: 1000,
  imbalanceThreshold: 1500,
  pressureFeeBps: 50,
  cooldownFeeBps: 25,
  cooldownTriggerMultiplier: 4,
  cooldownBlocks: 3,
};

const REGIME_LABEL = { 0: "calm", 1: "volatile" };

function format(label, d) {
  return (
    `${label}: fee=${d.feeBps}bps ` +
    `regime=${REGIME_LABEL[Number(d.regime)]} ` +
    `volatilityTicks=${d.volatilityScore} ` +
    `imbalance=${d.imbalanceScore} flags=${d.reasonFlags}`
  );
}

async function main() {
  const [, poolManager] = await ethers.getSigners();

  const Hook = await ethers.getContractFactory("AdaptiveFeeHook");
  const hook = await Hook.deploy(poolManager.address);
  await hook.waitForDeployment();

  const poolId = ethers.keccak256(ethers.toUtf8Bytes("demo-pool"));
  await (await hook.configurePool(poolId, baseConfig)).wait();

  const hookAsManager = hook.connect(poolManager);

  const scenarios = [
    { label: "calm swap", ref: 1000, cur: 1010, amount: 300, imbalance: 0, dir: 0 },
    { label: "volatile swap", ref: 1000, cur: 1125, amount: 300, imbalance: 0, dir: 0 },
    {
      label: "same-direction pressure",
      ref: 1000,
      cur: 1010,
      amount: 2000,
      imbalance: 2500,
      dir: 1,
    },
  ];

  for (const s of scenarios) {
    const d = await hookAsManager.beforeSwapDecision.staticCall(
      poolId,
      s.ref,
      s.cur,
      s.amount,
      s.imbalance,
      s.dir
    );
    console.log(format(s.label, d));
  }

  // Trigger cooldown with an extreme deviation, then show a follow-up swap is
  // charged the cooldown surcharge.
  await (await hookAsManager.beforeSwapDecision(poolId, 0, 1000, 300, 0, 0)).wait();
  const protected_ = await hookAsManager.beforeSwapDecision.staticCall(
    poolId,
    1000,
    1010,
    300,
    0,
    0
  );
  console.log(format("cooldown protected swap", protected_));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
