/**
 * Drive the already-deployed pool through the remaining fee branches:
 *   - cooldown surcharge (a follow-up swap right after deviation crossed
 *     the cooldownTriggerMultiplier line)
 *   - clamped-max (very large, very volatile swap)
 *   - imbalance (after the owner resets the reference tick so deviation
 *     drops back near zero, then a swap whose amount-to-liquidity ratio
 *     exceeds imbalanceThresholdBps)
 *
 * Reads deployments/xlayer-testnet.json for addresses. Requires the same
 * DEPLOYER_PK that owns the hook (only owner can resetReferenceTick).
 *
 * Run: DEPLOYER_PK=0x... RPC_URL=... node scripts/extra-swaps.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const REPORT = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "xlayer-testnet.json"), "utf8"));
const ART = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "build", "artifacts", `${n}.json`), "utf8"));

const RPC_URL = process.env.RPC_URL;
const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!RPC_URL || !DEPLOYER_PK) {
  console.error("Need RPC_URL + DEPLOYER_PK env vars.");
  process.exit(1);
}

const MIN_LIMIT = "4295128740";
const MAX_LIMIT = "1461446703485210103287273052203988822378723970341";
const FLAG_NAMES = { 1: "VOL", 2: "IMB", 4: "CD", 8: "CLAMPED_MAX", 16: "CLAMPED_MIN" };

function decodeReasons(flags) {
  const r = [];
  for (const [bit, name] of Object.entries(FLAG_NAMES)) {
    if ((Number(flags) & Number(bit)) !== 0) r.push(name);
  }
  return r;
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC_URL);
  const w = new ethers.Wallet(DEPLOYER_PK, p);
  const C = REPORT.contracts;

  const hook = new ethers.Contract(C.adaptiveFeeHookV4, ART("AdaptiveFeeHookV4").abi, w);
  const swapRouter = new ethers.Contract(C.swapRouter, ART("PoolSwapTest").abi, w);
  const hookIface = new ethers.Interface(ART("AdaptiveFeeHookV4").abi);

  const poolKey = {
    currency0: C.currency0,
    currency1: C.currency1,
    fee: 0x800000,
    tickSpacing: 60,
    hooks: C.adaptiveFeeHookV4
  };

  const followUps = [
    {
      label: "cooldown",
      desc: "Small swap right after the previous swap left deviation at 199 (just below the 200-tick cooldown trigger). We first push deviation past 200 with one extra zeroForOne swap, then a tiny calm swap should see the COOLDOWN flag.",
      preSwap: { zeroForOne: true, amount: -(10n ** 19n) },
      mainSwap: { zeroForOne: true, amount: -1000n }
    },
    {
      label: "imbalance",
      desc: "Reset referenceTick so deviation drops back near 0, then a swap whose amount/liquidity ratio exceeds imbalanceThresholdBps (1500 bps = 15%). With liquidity ≈ 1e21 we need amount ≥ 1.5e20.",
      resetRef: true,
      mainSwap: { zeroForOne: true, amount: -(2n * 10n ** 20n) }
    }
  ];

  const extraTxs = [];
  for (const fu of followUps) {
    console.log("\n---", fu.label, "---");
    console.log(fu.desc);

    if (fu.preSwap) {
      const tx = await swapRouter.swap(poolKey, {
        zeroForOne: fu.preSwap.zeroForOne,
        amountSpecified: fu.preSwap.amount,
        sqrtPriceLimitX96: fu.preSwap.zeroForOne ? MIN_LIMIT : MAX_LIMIT
      }, { takeClaims: false, settleUsingBurn: false }, "0x");
      const r = await tx.wait();
      console.log("  pre-swap tx:", r.hash);
      extraTxs.push({ label: fu.label + ":pre", hash: r.hash });
    }

    if (fu.resetRef) {
      const tx = await hook.resetReferenceTick(poolKey);
      const r = await tx.wait();
      console.log("  resetReferenceTick tx:", r.hash);
      extraTxs.push({ label: fu.label + ":resetRef", hash: r.hash });
    }

    const tx = await swapRouter.swap(poolKey, {
      zeroForOne: fu.mainSwap.zeroForOne,
      amountSpecified: fu.mainSwap.amount,
      sqrtPriceLimitX96: fu.mainSwap.zeroForOne ? MIN_LIMIT : MAX_LIMIT
    }, { takeClaims: false, settleUsingBurn: false }, "0x");
    const rcpt = await tx.wait();
    console.log("  main swap tx:", rcpt.hash);
    extraTxs.push({ label: fu.label, hash: rcpt.hash });

    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== C.adaptiveFeeHookV4.toLowerCase()) continue;
      try {
        const ev = hookIface.parseLog(log);
        if (ev.name !== "FeeDecisionRecorded") continue;
        const a = ev.args;
        console.log(
          "  ->",
          "feeBps=" + a.feeBps.toString().padStart(6),
          "regime=" + (a.regime == 1 ? "volatile" : "calm   "),
          "volScore=" + a.volatilityScore.toString().padStart(4),
          "imbScore=" + a.imbalanceScoreBps.toString().padStart(5),
          "flags=[" + decodeReasons(a.reasonFlags).join("|") + "]"
        );
      } catch {}
    }
  }

  // Append to report
  REPORT.extraTxs = (REPORT.extraTxs || []).concat(extraTxs);
  fs.writeFileSync(path.join(ROOT, "deployments", "xlayer-testnet.json"), JSON.stringify(REPORT, null, 2));
  console.log("\nAppended extraTxs to deployments/xlayer-testnet.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
