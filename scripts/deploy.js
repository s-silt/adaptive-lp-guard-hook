/**
 * End-to-end deployment + smoke test for AdaptiveFeeHookV4 on any EVM chain.
 *
 *  1. Deploys Create2Deployer (for mining the hook address).
 *  2. Deploys PoolManager (v4-core).
 *  3. Deploys two TestERC20s and the PoolSwapTest / PoolModifyLiquidityTest routers.
 *  4. Mines a CREATE2 salt whose address has BEFORE_SWAP + AFTER_INITIALIZE flag bits.
 *  5. Deploys AdaptiveFeeHookV4 through the Create2Deployer at the mined address.
 *  6. Calls configurePool(), initializes a dynamic-fee pool, adds liquidity, then
 *     runs three swaps (calm / volatile / imbalance) and prints every fee decision.
 *
 * Required env vars:
 *   RPC_URL       — e.g. https://testrpc.xlayer.tech/terigon for X Layer testnet
 *   DEPLOYER_PK   — private key of the funded deployer wallet
 *
 * Optional:
 *   CHAIN_LABEL   — short label to print in the report header (default: "unknown")
 *   OUT_FILE      — where to write the deployment report JSON (default: deployments/<chain>.json)
 *   NEW_OWNER_PK  — if set, after the smoke swaps the deployer calls transferOwner()
 *                   on the hook with this wallet's address; then the wallet itself
 *                   calls acceptOwner() — proving the two-step ownership handover on
 *                   chain. The new owner needs a small OKB balance to pay acceptOwner gas;
 *                   if its balance is zero, the deployer auto-funds it with 0.02 OKB.
 *
 * Run: node scripts/deploy.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { findSalt, permissionsToFlags } = require("./hookMiner");

const ROOT = path.resolve(__dirname, "..");
const ART = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "build", "artifacts", `${name}.json`), "utf8"));

const RPC_URL = process.env.RPC_URL;
const DEPLOYER_PK = process.env.DEPLOYER_PK;
const CHAIN_LABEL = process.env.CHAIN_LABEL || "unknown";
const OUT_FILE = process.env.OUT_FILE || path.join(ROOT, "deployments", `${CHAIN_LABEL}.json`);

if (!RPC_URL || !DEPLOYER_PK) {
  console.error("Missing env vars. Required: RPC_URL, DEPLOYER_PK");
  console.error("Optional: CHAIN_LABEL (default 'unknown'), OUT_FILE");
  process.exit(1);
}

// --- V4 constants ---
const DYNAMIC_FEE_FLAG = 0x800000;
const TICK_SPACING = 60;
const SQRT_PRICE_1_1 = "79228162514264337593543950336"; // sqrt(1) * 2^96

// --- AdaptiveFee config: produces ~30 bps base, escalates clearly with deviation ---
const POOL_CONFIG = {
  baseFeeBps: 3000,             // 30 bps in pip (hundredths of a bip, so 3000 = 0.30%)
  minFeeBps: 500,               // 5 bps floor
  maxFeeBps: 30000,             // 300 bps ceiling
  volatilityThresholdTicks: 50,
  volatilitySurchargeBaseBps: 5000,    // +50 bps when triggered
  volatilitySurchargeSlopeBps: 100,    // +1 bps per `scale` units over threshold
  volatilitySurchargeScale: 3,
  imbalanceThresholdBps: 1500,
  imbalanceSurchargeBps: 5000,         // +50 bps
  imbalanceMinAmount: 1000,
  cooldownTriggerMultiplier: 4,
  cooldownBlocks: 5,
  cooldownSurchargeBps: 2500,          // +25 bps
  referenceTickEmaWeightCalmBps: 2000,    // 20% — anchor tracks calm baseline drift
  referenceTickEmaWeightVolatileBps: 500  // 5%  — anchor barely moves while pool is hot
};

const HOOK_PERMS = {
  beforeInitialize: false,
  afterInitialize: true,
  beforeAddLiquidity: false,
  afterAddLiquidity: false,
  beforeRemoveLiquidity: false,
  afterRemoveLiquidity: false,
  beforeSwap: true,
  afterSwap: true,
  beforeDonate: false,
  afterDonate: false,
  beforeSwapReturnDelta: false,
  afterSwapReturnDelta: false,
  afterAddLiquidityReturnDelta: false,
  afterRemoveLiquidityReturnDelta: false
};

const MINT_AMOUNT = ethers.parseUnits("1000000", 18);
const LIQUIDITY = 10n ** 21n;
const MAX_UINT = (1n << 256n) - 1n;

async function deployFromArtifact(wallet, artifact, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(DEPLOYER_PK, provider);
  const network = await provider.getNetwork();

  console.log("=".repeat(70));
  console.log(`Deploying AdaptiveFeeHookV4 stack to ${CHAIN_LABEL} (chainId ${network.chainId})`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
  console.log("=".repeat(70));

  // 1. Create2Deployer
  console.log("\n[1/8] Deploying Create2Deployer...");
  const create2 = await deployFromArtifact(wallet, ART("Create2Deployer"));
  const create2Addr = await create2.getAddress();
  console.log("  ->", create2Addr);

  // 2. PoolManager (owner = wallet)
  console.log("\n[2/8] Deploying PoolManager...");
  const pm = await deployFromArtifact(wallet, ART("PoolManager"), [wallet.address]);
  const pmAddr = await pm.getAddress();
  console.log("  ->", pmAddr);

  // 3. Two ERC20s + routers
  console.log("\n[3/8] Deploying TestERC20s and routers...");
  const tokenA = await deployFromArtifact(wallet, ART("TestERC20"), [MINT_AMOUNT]);
  const tokenB = await deployFromArtifact(wallet, ART("TestERC20"), [MINT_AMOUNT]);
  const swapRouter = await deployFromArtifact(wallet, ART("PoolSwapTest"), [pmAddr]);
  const liqRouter = await deployFromArtifact(wallet, ART("PoolModifyLiquidityTest"), [pmAddr]);
  console.log("  tokenA:    ", await tokenA.getAddress());
  console.log("  tokenB:    ", await tokenB.getAddress());
  console.log("  swapRouter:", await swapRouter.getAddress());
  console.log("  liqRouter: ", await liqRouter.getAddress());

  // Sort tokens (PoolKey requires currency0 < currency1)
  const [tA, tB] = [await tokenA.getAddress(), await tokenB.getAddress()];
  const [currency0, currency1] = BigInt(tA) < BigInt(tB) ? [tA, tB] : [tB, tA];
  console.log("  currency0:", currency0);
  console.log("  currency1:", currency1);

  // 4. Mine hook salt
  console.log("\n[4/8] Mining hook address (BEFORE_SWAP + AFTER_INITIALIZE)...");
  const hookArt = ART("AdaptiveFeeHookV4");
  const flags = permissionsToFlags(HOOK_PERMS);
  const ctorArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [pmAddr, wallet.address]);
  const t0 = Date.now();
  const mined = findSalt(create2Addr, flags, hookArt.bytecode, ctorArgs);
  console.log(`  flags: 0x${flags.toString(16).padStart(4, "0")}`);
  console.log(`  mined: ${mined.address}  (salt=${mined.salt}, attempts=${mined.attempts}, ${Date.now() - t0}ms)`);

  // 5. Deploy hook via Create2Deployer
  console.log("\n[5/8] Deploying AdaptiveFeeHookV4 via Create2Deployer...");
  const initCode = ethers.concat([hookArt.bytecode, ctorArgs]);
  const tx = await create2.deploy(mined.salt, initCode);
  const rcpt = await tx.wait();
  console.log(`  tx: ${rcpt.hash}`);
  console.log(`  hook deployed at: ${mined.address}`);

  // Verify hook is at expected address with bytecode.
  // X Layer testnet RPC sometimes lags behind tx finality, so retry briefly.
  let code = "0x";
  for (let i = 0; i < 20; i++) {
    code = await provider.getCode(mined.address);
    if (code !== "0x") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (code === "0x") throw new Error("Hook deployment failed — no code at mined address after 30s");
  const hookAbi = hookArt.abi;
  const hook = new ethers.Contract(mined.address, hookAbi, wallet);

  // 6. Configure pool
  console.log("\n[6/8] Configuring pool fee model + initializing dynamic-fee pool...");
  const poolKey = {
    currency0,
    currency1,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: TICK_SPACING,
    hooks: mined.address
  };

  const cfgArray = [
    POOL_CONFIG.baseFeeBps, POOL_CONFIG.minFeeBps, POOL_CONFIG.maxFeeBps,
    POOL_CONFIG.volatilityThresholdTicks, POOL_CONFIG.volatilitySurchargeBaseBps,
    POOL_CONFIG.volatilitySurchargeSlopeBps, POOL_CONFIG.volatilitySurchargeScale,
    POOL_CONFIG.imbalanceThresholdBps, POOL_CONFIG.imbalanceSurchargeBps, POOL_CONFIG.imbalanceMinAmount,
    POOL_CONFIG.cooldownTriggerMultiplier, POOL_CONFIG.cooldownBlocks, POOL_CONFIG.cooldownSurchargeBps,
    POOL_CONFIG.referenceTickEmaWeightCalmBps, POOL_CONFIG.referenceTickEmaWeightVolatileBps
  ];
  const cfgTx = await hook.configurePool(poolKey, cfgArray);
  await cfgTx.wait();
  console.log(`  configurePool tx: ${cfgTx.hash}`);

  // Initialize pool
  const initTx = await pm.initialize(poolKey, SQRT_PRICE_1_1);
  const initRcpt = await initTx.wait();
  console.log(`  initialize tx: ${initRcpt.hash}`);

  // 7. Add liquidity
  console.log("\n[7/8] Adding initial liquidity...");
  // Approve routers
  for (const t of [tokenA, tokenB]) {
    await (await t.approve(await liqRouter.getAddress(), MAX_UINT)).wait();
    await (await t.approve(await swapRouter.getAddress(), MAX_UINT)).wait();
  }
  // X Layer testnet RPC can lag a couple of seconds behind tx finality, which makes
  // estimateGas read stale allowance state. Give it a moment.
  await new Promise((r) => setTimeout(r, 5000));

  const liqParams = {
    tickLower: -TICK_SPACING * 10,
    tickUpper: TICK_SPACING * 10,
    liquidityDelta: LIQUIDITY,
    salt: ethers.ZeroHash
  };
  const liqTx = await liqRouter.modifyLiquidity(poolKey, liqParams, "0x", { gasLimit: 3_000_000 });
  await liqTx.wait();
  console.log(`  modifyLiquidity tx: ${liqTx.hash}`);

  // 8. Run 3 swaps to demonstrate the three fee branches
  console.log("\n[8/8] Running smoke swaps...");
  const swapSettings = { takeClaims: false, settleUsingBurn: false };
  const swaps = [
    { label: "calm",      zeroForOne: true,  amount: -1000n },
    { label: "volatile",  zeroForOne: true,  amount: -(LIQUIDITY / 100n) },
    { label: "imbalance", zeroForOne: false, amount: -(LIQUIDITY / 200n) }
  ];

  const txs = [];
  for (const s of swaps) {
    const params = {
      zeroForOne: s.zeroForOne,
      amountSpecified: s.amount,
      sqrtPriceLimitX96: s.zeroForOne ? "4295128740" : "1461446703485210103287273052203988822378723970341"
    };
    const swapTx = await swapRouter.swap(poolKey, params, swapSettings, "0x", { gasLimit: 3_000_000 });
    const swapRcpt = await swapTx.wait();
    console.log(`  ${s.label.padEnd(10)} tx: ${swapRcpt.hash}`);
    txs.push({ label: s.label, hash: swapRcpt.hash });
  }

  // Optional: hand the hook over to a fresh wallet via the two-step transferOwner / acceptOwner flow
  let ownershipHandover = null;
  if (process.env.NEW_OWNER_PK) {
    console.log("\n[9/9] Transferring hook ownership to a fresh wallet...");
    const newOwnerWallet = new ethers.Wallet(process.env.NEW_OWNER_PK, provider);
    const newOwnerAddr = newOwnerWallet.address;
    console.log("  new owner:", newOwnerAddr);

    // Make sure the new owner can pay acceptOwner gas.
    const newOwnerBal = await provider.getBalance(newOwnerAddr);
    let fundTxHash = null;
    if (newOwnerBal === 0n) {
      console.log("  funding new owner with 0.02 OKB for acceptOwner gas...");
      const fundTx = await wallet.sendTransaction({
        to: newOwnerAddr,
        value: ethers.parseEther("0.02")
      });
      const fundRcpt = await fundTx.wait();
      fundTxHash = fundRcpt.hash;
      console.log("  fund tx:", fundTxHash);
    } else {
      console.log("  new owner already has", ethers.formatEther(newOwnerBal), "OKB; skipping fund step");
    }

    const transferTx = await hook.transferOwner(newOwnerAddr);
    const transferRcpt = await transferTx.wait();
    console.log("  transferOwner tx:", transferRcpt.hash);

    const hookFromNewOwner = new ethers.Contract(mined.address, hookAbi, newOwnerWallet);
    const acceptTx = await hookFromNewOwner.acceptOwner();
    const acceptRcpt = await acceptTx.wait();
    console.log("  acceptOwner tx:  ", acceptRcpt.hash);

    // X Layer testnet RPC sometimes lags behind tx finality, so retry the read briefly.
    let finalOwner;
    for (let i = 0; i < 20; i++) {
      finalOwner = await hook.owner();
      if (finalOwner.toLowerCase() === newOwnerAddr.toLowerCase()) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (finalOwner.toLowerCase() !== newOwnerAddr.toLowerCase()) {
      throw new Error(`Ownership handover failed: hook.owner() = ${finalOwner}, expected ${newOwnerAddr} (after 30s)`);
    }
    console.log("  hook.owner() now:", finalOwner, "✅");

    ownershipHandover = {
      previousOwner: wallet.address,
      newOwner: newOwnerAddr,
      fundTx: fundTxHash,
      transferOwnerTx: transferRcpt.hash,
      acceptOwnerTx: acceptRcpt.hash
    };
  }

  // Write deployment report
  const report = {
    chain: { label: CHAIN_LABEL, chainId: Number(network.chainId) },
    deployer: wallet.address,
    contracts: {
      create2Deployer: create2Addr,
      poolManager: pmAddr,
      tokenA: await tokenA.getAddress(),
      tokenB: await tokenB.getAddress(),
      currency0,
      currency1,
      swapRouter: await swapRouter.getAddress(),
      liquidityRouter: await liqRouter.getAddress(),
      adaptiveFeeHookV4: mined.address
    },
    poolKey: { ...poolKey, fee: `0x${poolKey.fee.toString(16)}` },
    poolConfig: POOL_CONFIG,
    miner: { salt: mined.salt, attempts: mined.attempts },
    txs,
    ownershipHandover,
    timestamp: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  console.log("\nReport written to:", path.relative(ROOT, OUT_FILE));
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nDeployment failed:");
  console.error(err);
  process.exit(1);
});
