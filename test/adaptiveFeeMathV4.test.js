/**
 * AdaptiveFeeMathV4 — parameterised fee response sanity check.
 *
 * WARNING — JS mirror.
 *   These assertions run against a JavaScript reimplementation of decide().
 *   The real Solidity logic in contracts/v4/AdaptiveFeeMathV4.sol is verified
 *   on-chain by the deploy + smoke-swap flow in scripts/deploy.js. If you
 *   change the Solidity formula, update mirrorDecide below in lockstep or this
 *   suite will silently drift out of sync.
 *
 *   This file exists because the dev box (Windows ARM64) cannot run anvil or
 *   the Hardhat node, so the only place full V4 contract behaviour is
 *   exercised is X Layer testnet. Treat this as a fast formula regression net,
 *   not as proof the contract works.
 */
const { expect } = require("chai");

const baseConfig = () => ({
  baseFeeBps: 3000,
  minFeeBps: 500,
  maxFeeBps: 30000,
  volatilityThresholdTicks: 50,
  volatilitySurchargeBaseBps: 5000,
  volatilitySurchargeSlopeBps: 100,
  volatilitySurchargeScale: 3,
  imbalanceThresholdBps: 1500,
  imbalanceSurchargeBps: 5000,
  imbalanceMinAmount: 1000,
  cooldownTriggerMultiplier: 4,
  cooldownBlocks: 5,
  cooldownSurchargeBps: 2500,
  // EMA weights default to 0 here so the existing decide() mirror tests are unaffected.
  // Tests that exercise updateAnchor explicitly set these.
  referenceTickEmaWeightCalmBps: 0,
  referenceTickEmaWeightVolatileBps: 0
});

const FLAG_VOLATILITY = 1;
const FLAG_IMBALANCE = 2;
const FLAG_COOLDOWN = 4;
const FLAG_CLAMPED_MAX = 8;
const FLAG_CLAMPED_MIN = 16;

function mirrorDecide(cfg, refTick, curTick, amountAbs, imbBps, pressDir, cooldownActive) {
  const deviation = Math.abs(refTick - curTick);
  let fee = cfg.baseFeeBps;
  let reasonFlags = 0;
  let regime = 0;

  if (deviation >= cfg.volatilityThresholdTicks) {
    const over = deviation - cfg.volatilityThresholdTicks;
    const scale = cfg.volatilitySurchargeScale === 0 ? 1 : cfg.volatilitySurchargeScale;
    fee += cfg.volatilitySurchargeBaseBps + Math.floor((over * cfg.volatilitySurchargeSlopeBps) / scale);
    reasonFlags |= FLAG_VOLATILITY;
    regime = 1;
  }

  if (pressDir !== 0 && amountAbs >= cfg.imbalanceMinAmount && imbBps >= cfg.imbalanceThresholdBps) {
    fee += cfg.imbalanceSurchargeBps;
    reasonFlags |= FLAG_IMBALANCE;
  }
  if (cooldownActive) {
    fee += cfg.cooldownSurchargeBps;
    reasonFlags |= FLAG_COOLDOWN;
  }
  if (fee < cfg.minFeeBps) { fee = cfg.minFeeBps; reasonFlags |= FLAG_CLAMPED_MIN; }
  if (fee > cfg.maxFeeBps) { fee = cfg.maxFeeBps; reasonFlags |= FLAG_CLAMPED_MAX; }

  return {
    feeBps: fee, reasonFlags, regime,
    volatilityScore: deviation, imbalanceScoreBps: imbBps,
    enterCooldown: deviation >= cfg.volatilityThresholdTicks * cfg.cooldownTriggerMultiplier
  };
}

function mirrorUpdateAnchor(cfg, refTick, curTick, cooldownActive) {
  const weight = cooldownActive
    ? cfg.referenceTickEmaWeightVolatileBps
    : cfg.referenceTickEmaWeightCalmBps;
  if (weight === 0 || refTick === curTick) return refTick;
  if (weight === 10000) return curTick;

  const diff = curTick - refTick;
  // Solidity does `(diff * weight) / 10000` with truncated integer division. Math.trunc
  // mirrors that exactly for both positive and negative `diff`.
  let step = Math.trunc((diff * weight) / 10000);
  if (step === 0) step = diff > 0 ? 1 : -1;
  let proposed = refTick + step;
  const lo = Math.min(refTick, curTick);
  const hi = Math.max(refTick, curTick);
  if (proposed < lo) proposed = lo;
  if (proposed > hi) proposed = hi;
  return proposed;
}

describe("AdaptiveFeeMathV4 (JS mirror, see file header)", function () {
  it("returns base fee for a calm swap inside thresholds", function () {
    const d = mirrorDecide(baseConfig(), 1000, 1010, 300, 0, 0, false);
    expect(d.feeBps).to.equal(3000);
    expect(d.reasonFlags).to.equal(0);
    expect(d.regime).to.equal(0);
    expect(d.enterCooldown).to.equal(false);
  });

  it("adds the parameterised volatility surcharge with slope", function () {
    // deviation = 125, over = 75, surcharge = 5000 + floor(75 * 100 / 3) = 5000 + 2500 = 7500
    const d = mirrorDecide(baseConfig(), 1000, 1125, 300, 0, 0, false);
    expect(d.feeBps).to.equal(3000 + 7500);
    expect(d.reasonFlags & FLAG_VOLATILITY).to.equal(FLAG_VOLATILITY);
    expect(d.regime).to.equal(1);
  });

  it("adds the imbalance surcharge for large same-direction pressure", function () {
    // baseFee + imbalanceSurcharge, no volatility (deviation = 10 < 50)
    const d = mirrorDecide(baseConfig(), 1000, 1010, 2000, 2500, 1, false);
    expect(d.feeBps).to.equal(3000 + 5000);
    expect(d.reasonFlags & FLAG_IMBALANCE).to.equal(FLAG_IMBALANCE);
  });

  it("ignores imbalance pressure below imbalanceMinAmount", function () {
    const d = mirrorDecide(baseConfig(), 1000, 1010, 500, 2500, 1, false);
    expect(d.feeBps).to.equal(3000);
    expect(d.reasonFlags).to.equal(0);
  });

  it("ignores imbalance pressure when score is below threshold", function () {
    const d = mirrorDecide(baseConfig(), 1000, 1010, 2000, 1499, 1, false);
    expect(d.feeBps).to.equal(3000);
  });

  it("ignores imbalance when pressureDirection is zero", function () {
    const d = mirrorDecide(baseConfig(), 1000, 1010, 2000, 2500, 0, false);
    expect(d.feeBps).to.equal(3000);
  });

  it("clamps to maxFeeBps and sets the clamped-max flag", function () {
    // deviation = 1000, surcharge = 5000 + floor(950 * 100 / 3) = 5000 + 31666 = 36666
    // base 3000 + 36666 + 5000 (imbalance) = 44666 → clamped to 30000
    const d = mirrorDecide(baseConfig(), 1000, 2000, 100000, 10000, 1, false);
    expect(d.feeBps).to.equal(30000);
    expect(d.reasonFlags & FLAG_CLAMPED_MAX).to.equal(FLAG_CLAMPED_MAX);
  });

  it("triggers enterCooldown when deviation >= threshold * cooldownTriggerMultiplier", function () {
    // 50 * 4 = 200, so deviation 200+ triggers
    expect(mirrorDecide(baseConfig(), 1000, 1199, 0, 0, 0, false).enterCooldown).to.equal(false);
    expect(mirrorDecide(baseConfig(), 1000, 1200, 0, 0, 0, false).enterCooldown).to.equal(true);
  });

  it("applies the cooldown surcharge while cooldown is active", function () {
    const d = mirrorDecide(baseConfig(), 1000, 1010, 300, 0, 0, true);
    expect(d.feeBps).to.equal(3000 + 2500);
    expect(d.reasonFlags & FLAG_COOLDOWN).to.equal(FLAG_COOLDOWN);
  });

  it("supports tweaking the volatility slope at config time", function () {
    const cfg = baseConfig();
    cfg.volatilitySurchargeSlopeBps = 200;     // doubled slope
    cfg.volatilitySurchargeScale = 1;          // tighter scale
    // deviation = 60, over = 10, surcharge = 5000 + floor(10*200/1) = 7000
    const d = mirrorDecide(cfg, 1000, 1060, 300, 0, 0, false);
    expect(d.feeBps).to.equal(3000 + 7000);
  });
});

describe("AdaptiveFeeMathV4.updateAnchor (JS mirror)", function () {
  const cfgWithEma = (calmBps, volBps) => ({
    ...baseConfig(),
    referenceTickEmaWeightCalmBps: calmBps,
    referenceTickEmaWeightVolatileBps: volBps
  });

  it("returns referenceTick unchanged when calm weight is zero", function () {
    expect(mirrorUpdateAnchor(cfgWithEma(0, 0), 1000, 1100, false)).to.equal(1000);
  });

  it("returns currentTick when weight is 10000 (snap)", function () {
    expect(mirrorUpdateAnchor(cfgWithEma(10000, 10000), 1000, 1100, false)).to.equal(1100);
  });

  it("uses calm weight by default and volatile weight inside cooldown", function () {
    const cfg = cfgWithEma(2000, 500);  // 20% calm, 5% volatile
    // diff = 100, calm step = floor(100 * 2000 / 10000) = 20 → newRef = 1020
    expect(mirrorUpdateAnchor(cfg, 1000, 1100, false)).to.equal(1020);
    // diff = 100, volatile step = floor(100 * 500 / 10000) = 5 → newRef = 1005
    expect(mirrorUpdateAnchor(cfg, 1000, 1100, true)).to.equal(1005);
  });

  it("snaps to ±1 when integer truncation would zero the step (Option A policy)", function () {
    // diff = 10, weight = 500 (5%): 10 * 500 / 10000 = 0.5 → trunc = 0 → forced +1
    expect(mirrorUpdateAnchor(cfgWithEma(500, 500), 1000, 1010, false)).to.equal(1001);
    // diff = -10, weight = 500: trunc = 0 → forced -1
    expect(mirrorUpdateAnchor(cfgWithEma(500, 500), 1000, 990, false)).to.equal(999);
  });

  it("works with negative ticks", function () {
    const cfg = cfgWithEma(2500, 1000);
    // diff = 100, step = 25 → -100 + 25 = -75
    expect(mirrorUpdateAnchor(cfg, -100, 0, false)).to.equal(-75);
    // diff = -200, step = floor(-200 * 2500 / 10000) = -50 → 0 + (-50) = -50
    expect(mirrorUpdateAnchor(cfg, 0, -200, false)).to.equal(-50);
  });

  it("never overshoots currentTick", function () {
    // Even with weight = 9999 the result must stay <= currentTick (rounding can't push past).
    expect(mirrorUpdateAnchor(cfgWithEma(9999, 9999), 1000, 1001, false)).to.equal(1001);
    expect(mirrorUpdateAnchor(cfgWithEma(9999, 9999), 1001, 1000, false)).to.equal(1000);
  });

  it("returns referenceTick if it already equals currentTick", function () {
    expect(mirrorUpdateAnchor(cfgWithEma(5000, 5000), 500, 500, false)).to.equal(500);
  });
});
