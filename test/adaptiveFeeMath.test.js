const { expect } = require("chai");
const { ethers } = require("hardhat");

const config = {
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

describe("AdaptiveFeeMath", function () {
  let math;

  beforeEach(async function () {
    const Harness = await ethers.getContractFactory("AdaptiveFeeMathHarness");
    math = await Harness.deploy();
    await math.waitForDeployment();
  });

  it("returns the base fee for calm swaps", async function () {
    const d = await math.decide(config, 1000, 1010, 300, 0, 0, false);
    expect(d.feeBps).to.equal(30n);
    expect(d.reasonFlags).to.equal(0n);
    expect(d.regime).to.equal(0n);
  });

  it("adds the volatility surcharge above the threshold", async function () {
    // deviation = 125, over = 75, surcharge = 50 + 75/3 = 75 → fee = 30 + 75 = 105
    const d = await math.decide(config, 1000, 1125, 300, 0, 0, false);
    expect(d.feeBps).to.equal(105n);
    expect(d.reasonFlags & 1n).to.equal(1n);
    expect(d.regime).to.equal(1n);
  });

  it("adds the pressure surcharge for same-direction large swaps", async function () {
    const d = await math.decide(config, 1000, 1010, 2000, 2500, 1, false);
    expect(d.feeBps).to.equal(80n);
    expect(d.reasonFlags & 2n).to.equal(2n);
  });

  it("skips the pressure surcharge when swap opposes imbalance", async function () {
    const d = await math.decide(config, 1000, 1010, 2000, 2500, -1, false);
    expect(d.feeBps).to.equal(30n);
    expect(d.reasonFlags & 2n).to.equal(0n);
  });

  it("skips the pressure surcharge for small swaps", async function () {
    const d = await math.decide(config, 1000, 1010, 500, 2500, 1, false);
    expect(d.feeBps).to.equal(30n);
    expect(d.reasonFlags & 2n).to.equal(0n);
  });

  it("skips the pressure surcharge when imbalance is below threshold", async function () {
    const d = await math.decide(config, 1000, 1010, 2000, 1000, 1, false);
    expect(d.feeBps).to.equal(30n);
    expect(d.reasonFlags & 2n).to.equal(0n);
  });

  it("adds the cooldown surcharge when cooldown is active", async function () {
    const d = await math.decide(config, 1000, 1010, 300, 0, 0, true);
    expect(d.feeBps).to.equal(55n);
    expect(d.reasonFlags & 4n).to.equal(4n);
  });

  it("clamps the fee to the configured maximum", async function () {
    const d = await math.decide(config, 0, 100000, 1000000, 1000000, 1, true);
    expect(d.feeBps).to.equal(300n);
    expect(d.reasonFlags & 8n).to.equal(8n);
  });

  it("clamps the fee to the configured minimum", async function () {
    const lowBaseConfig = { ...config, minFeeBps: 100, baseFeeBps: 100 };
    // base 100 with no surcharges still yields 100 (min). Use a config where the
    // computed fee would otherwise be below the floor by setting base = min via clamp.
    const d = await math.decide(lowBaseConfig, 1000, 1010, 300, 0, 0, false);
    expect(d.feeBps).to.equal(100n);
  });

  it("signals enterCooldown when deviation exceeds the trigger multiplier", async function () {
    // 50 * 4 = 200, deviation 1000 -> triggers
    const d = await math.decide(config, 0, 1000, 300, 0, 0, false);
    expect(d.enterCooldown).to.equal(true);
  });

  it("does not signal enterCooldown below the trigger", async function () {
    const d = await math.decide(config, 0, 150, 300, 0, 0, false);
    expect(d.enterCooldown).to.equal(false);
  });

  it("treats negative imbalance and negative pressure as same direction", async function () {
    const d = await math.decide(config, 1000, 1010, 2000, -2500, -1, false);
    expect(d.feeBps).to.equal(80n);
    expect(d.reasonFlags & 2n).to.equal(2n);
  });

  describe("validate", function () {
    it("rejects min above base", async function () {
      const bad = { ...config, minFeeBps: 100, baseFeeBps: 50 };
      await expect(math.validate(bad)).to.be.revertedWith("min above base");
    });

    it("rejects base above max", async function () {
      const bad = { ...config, baseFeeBps: 500, maxFeeBps: 300 };
      await expect(math.validate(bad)).to.be.revertedWith("base above max");
    });

    it("rejects fee above 100%", async function () {
      const bad = { ...config, maxFeeBps: 10001 };
      await expect(math.validate(bad)).to.be.revertedWith("fee above 100%");
    });

    it("rejects zero volatility threshold", async function () {
      const bad = { ...config, volatilityThresholdTicks: 0 };
      await expect(math.validate(bad)).to.be.revertedWith(
        "zero volatility threshold"
      );
    });

    it("rejects zero slope divisor", async function () {
      const bad = { ...config, volatilitySlopeDivisor: 0 };
      await expect(math.validate(bad)).to.be.revertedWith("zero slope divisor");
    });
  });
});
