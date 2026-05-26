const { expect } = require("chai");
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

const POOL_ID = ethers.keccak256(ethers.toUtf8Bytes("test-pool"));

describe("AdaptiveFeeHook", function () {
  let hook;
  let owner;
  let poolManager;
  let alice;

  beforeEach(async function () {
    [owner, poolManager, alice] = await ethers.getSigners();
    const Hook = await ethers.getContractFactory("AdaptiveFeeHook");
    hook = await Hook.deploy(poolManager.address);
    await hook.waitForDeployment();
  });

  describe("constructor", function () {
    it("sets the owner and the pool manager", async function () {
      expect(await hook.owner()).to.equal(owner.address);
      expect(await hook.poolManager()).to.equal(poolManager.address);
    });

    it("rejects a zero pool manager", async function () {
      const Hook = await ethers.getContractFactory("AdaptiveFeeHook");
      await expect(Hook.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "zero pool manager"
      );
    });
  });

  describe("configurePool", function () {
    it("lets the owner configure pools", async function () {
      await expect(hook.configurePool(POOL_ID, baseConfig)).to.emit(
        hook,
        "PoolConfigured"
      );
      expect(await hook.isConfigured(POOL_ID)).to.equal(true);
    });

    it("rejects unauthorized callers", async function () {
      await expect(
        hook.connect(alice).configurePool(POOL_ID, baseConfig)
      ).to.be.revertedWith("not pool admin");
    });

    it("lets a designated pool admin configure that pool", async function () {
      await hook.setPoolAdmin(POOL_ID, alice.address);
      await expect(
        hook.connect(alice).configurePool(POOL_ID, baseConfig)
      ).to.emit(hook, "PoolConfigured");
    });

    it("validates the config", async function () {
      const bad = { ...baseConfig, minFeeBps: 999 };
      await expect(hook.configurePool(POOL_ID, bad)).to.be.revertedWith(
        "min above base"
      );
    });
  });

  describe("setPoolAdmin", function () {
    it("can only be called by the owner", async function () {
      await expect(
        hook.connect(alice).setPoolAdmin(POOL_ID, alice.address)
      ).to.be.revertedWith("not owner");
    });

    it("rejects the zero address", async function () {
      await expect(
        hook.setPoolAdmin(POOL_ID, ethers.ZeroAddress)
      ).to.be.revertedWith("zero admin");
    });
  });

  describe("getConfig", function () {
    it("returns the stored config", async function () {
      await hook.configurePool(POOL_ID, baseConfig);
      const stored = await hook.getConfig(POOL_ID);
      expect(stored.baseFeeBps).to.equal(30n);
      expect(stored.cooldownBlocks).to.equal(3n);
      expect(stored.cooldownTriggerMultiplier).to.equal(4n);
    });
  });

  describe("beforeSwapDecision", function () {
    beforeEach(async function () {
      await hook.configurePool(POOL_ID, baseConfig);
    });

    it("rejects callers other than the pool manager", async function () {
      await expect(
        hook
          .connect(alice)
          .beforeSwapDecision(POOL_ID, 1000, 1010, 300, 0, 0)
      ).to.be.revertedWith("not pool manager");
    });

    it("reverts for unconfigured pools", async function () {
      const otherPool = ethers.keccak256(ethers.toUtf8Bytes("missing"));
      await expect(
        hook
          .connect(poolManager)
          .beforeSwapDecision(otherPool, 1000, 1010, 300, 0, 0)
      ).to.be.revertedWith("pool not configured");
    });

    it("returns the base fee for calm swaps", async function () {
      const d = await hook
        .connect(poolManager)
        .beforeSwapDecision.staticCall(POOL_ID, 1000, 1010, 300, 0, 0);
      expect(d.feeBps).to.equal(30n);
      expect(d.reasonFlags).to.equal(0n);
    });

    it("emits FeeDecisionRecorded", async function () {
      await expect(
        hook
          .connect(poolManager)
          .beforeSwapDecision(POOL_ID, 1000, 1010, 300, 0, 0)
      ).to.emit(hook, "FeeDecisionRecorded");
    });

    it("activates cooldown on extreme deviations", async function () {
      await expect(
        hook
          .connect(poolManager)
          .beforeSwapDecision(POOL_ID, 0, 1000, 300, 0, 0)
      ).to.emit(hook, "CooldownActivated");
      expect(await hook.cooldownUntilBlock(POOL_ID)).to.be.gt(0n);
    });

    it("surcharges later swaps while cooldown is active", async function () {
      await hook
        .connect(poolManager)
        .beforeSwapDecision(POOL_ID, 0, 1000, 300, 0, 0);
      const d = await hook
        .connect(poolManager)
        .beforeSwapDecision.staticCall(POOL_ID, 1000, 1010, 300, 0, 0);
      expect(d.feeBps).to.equal(55n);
      expect(d.reasonFlags & 4n).to.equal(4n);
    });
  });

  describe("transferOwnership", function () {
    it("transfers to a new owner", async function () {
      await expect(hook.transferOwnership(alice.address))
        .to.emit(hook, "OwnershipTransferred")
        .withArgs(owner.address, alice.address);
      expect(await hook.owner()).to.equal(alice.address);
    });

    it("rejects non-owner callers", async function () {
      await expect(
        hook.connect(alice).transferOwnership(alice.address)
      ).to.be.revertedWith("not owner");
    });

    it("rejects the zero address", async function () {
      await expect(
        hook.transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("zero owner");
    });
  });
});
