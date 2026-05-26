/**
 * Self-test for hookMiner: given a fake deployer + the compiled AdaptiveFeeHookV4
 * creation code + a fake PoolManager constructor arg, find a salt whose CREATE2
 * address has the bottom 14 bits matching `beforeSwap + afterInitialize`.
 *
 * Pure off-chain check — no RPC needed. Run: `node scripts/mine.js`
 */
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");
const { findSalt, permissionsToFlags, HOOK_FLAGS } = require("./hookMiner");

const artifactPath = path.join(__dirname, "..", "build", "artifacts", "AdaptiveFeeHookV4.json");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

const FAKE_DEPLOYER = "0x" + "11".repeat(20);
const FAKE_POOL_MANAGER = "0x" + "22".repeat(20);

const flags = permissionsToFlags({
  beforeInitialize: false,
  afterInitialize: true,
  beforeAddLiquidity: false,
  afterAddLiquidity: false,
  beforeRemoveLiquidity: false,
  afterRemoveLiquidity: false,
  beforeSwap: true,
  afterSwap: false,
  beforeDonate: false,
  afterDonate: false,
  beforeSwapReturnDelta: false,
  afterSwapReturnDelta: false,
  afterAddLiquidityReturnDelta: false,
  afterRemoveLiquidityReturnDelta: false
});

console.log("Target flag mask (bottom 14 bits):", "0x" + flags.toString(16).padStart(4, "0"));
console.log("  expected: AFTER_INITIALIZE(0x1000) | BEFORE_SWAP(0x80) = 0x1080");

const FAKE_OWNER = "0x" + "33".repeat(20);
const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [FAKE_POOL_MANAGER, FAKE_OWNER]);

const start = Date.now();
const result = findSalt(FAKE_DEPLOYER, flags, artifact.bytecode, constructorArgs);
const elapsed = Date.now() - start;

console.log("Mined hook address:", result.address);
console.log("Salt:", result.salt);
console.log("Attempts:", result.attempts);
console.log("Bottom 14 bits:", "0x" + (parseInt(result.address.slice(-4), 16) & ((1 << 14) - 1)).toString(16).padStart(4, "0"));
console.log("Time:", elapsed + "ms");

if ((parseInt(result.address.slice(-4), 16) & ((1 << 14) - 1)) !== flags) {
  console.error("FAIL: mined address bottom 14 bits do not match target flags");
  process.exit(1);
}
console.log("PASS");
