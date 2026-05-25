const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const config = {
  baseFeeBps: 30,
  minFeeBps: 5,
  maxFeeBps: 300,
  volatilityThresholdTicks: 50,
  imbalanceThresholdBps: 1_500,
  cooldownBlocks: 3
};

function compileHook() {
  const root = path.join(__dirname, "..");
  const sources = {
    "AdaptiveFeeHook.sol": {
      content: fs.readFileSync(path.join(root, "contracts", "AdaptiveFeeHook.sol"), "utf8")
    },
    "AdaptiveFeeMath.sol": {
      content: fs.readFileSync(path.join(root, "contracts", "AdaptiveFeeMath.sol"), "utf8")
    }
  };
  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode"]
        }
      }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  }
  return output.contracts["AdaptiveFeeHook.sol"].AdaptiveFeeHook;
}

function decide(referenceTick, currentTick, amountSpecified, imbalanceScoreBps, pressureDirection, cooldownActive) {
  const deviation = Math.abs(referenceTick - currentTick);
  let fee = config.baseFeeBps;
  let reasonFlags = 0;
  let regime = 0;

  if (deviation >= config.volatilityThresholdTicks) {
    fee += 50 + Math.floor((deviation - config.volatilityThresholdTicks) / 3);
    reasonFlags |= 1;
    regime = 1;
  }

  if (pressureDirection !== 0 && amountSpecified >= 1_000 && imbalanceScoreBps >= config.imbalanceThresholdBps) {
    fee += 50;
    reasonFlags |= 2;
  }

  if (cooldownActive) {
    fee += 25;
    reasonFlags |= 4;
  }

  if (fee < config.minFeeBps) {
    fee = config.minFeeBps;
  }

  if (fee > config.maxFeeBps) {
    fee = config.maxFeeBps;
    reasonFlags |= 8;
  }

  return {
    feeBps: fee,
    reasonFlags,
    regime,
    volatilityScore: deviation,
    imbalanceScoreBps,
    enterCooldown: deviation >= config.volatilityThresholdTicks * 4
  };
}

describe("AdaptiveFeeHook", function () {
  it("compiles the Solidity hook and exposes the fee decision API", function () {
    const compiled = compileHook();

    const names = compiled.abi.map((entry) => entry.name).filter(Boolean);
    expect(names).to.include("configurePool");
    expect(names).to.include("beforeSwapDecision");
    expect(compiled.evm.bytecode.object.length).to.be.greaterThan(0);
  });

  it("returns the base fee for calm swaps", function () {
    const decision = decide(1000, 1010, 300, 0, 0, false);
    expect(decision.feeBps).to.equal(30);
    expect(decision.reasonFlags).to.equal(0);
    expect(decision.regime).to.equal(0);
  });

  it("adds a volatility surcharge when tick deviation is high", function () {
    const decision = decide(1000, 1125, 300, 0, 0, false);

    expect(decision.feeBps).to.equal(105);
    expect(decision.reasonFlags & 1).to.equal(1);
    expect(decision.regime).to.equal(1);
  });

  it("adds an imbalance surcharge for large same-direction swaps", function () {
    const decision = decide(1000, 1010, 2_000, 2_500, 1, false);

    expect(decision.feeBps).to.equal(80);
    expect(decision.reasonFlags & 2).to.equal(2);
  });

  it("clamps fees to the configured maximum", function () {
    const decision = decide(1000, 2_000, 100_000, 10_000, 1, false);

    expect(decision.feeBps).to.equal(300);
    expect(decision.reasonFlags & 8).to.equal(8);
  });

  it("activates cooldown after extreme deviation and surcharges later swaps", function () {
    const first = decide(1000, 2_000, 300, 0, 0, false);
    const decision = decide(1000, 1010, 300, 0, 0, first.enterCooldown);

    expect(decision.feeBps).to.equal(55);
    expect(decision.reasonFlags & 4).to.equal(4);
  });
});
