# Adaptive LP Guard Hook

A Uniswap v4 dynamic-fee hook that protects LPs by composing three risk signals — tick volatility, swap-size imbalance, and a cooldown circuit breaker — into the per-swap LP fee.

Built for the **OKX X Layer Build-X Hackathon (Hook track)**, in collaboration with Uniswap and Flap.

## What ships in this repo

Two implementations live side-by-side:

| Path | Purpose |
|---|---|
| `contracts/AdaptiveFeeHook.sol` + `contracts/AdaptiveFeeMath.sol` | Hardened MVP — standalone fee-decision engine with a v4-style API surface. Adds `onlyOwner` / `onlyPoolAdmin` / `onlyPoolManager` gating, per-pool parameterisation, and real Hardhat-based Solidity tests (`test/adaptiveFeeHook.test.js`, `test/adaptiveFeeMath.test.js`). Adapter-friendly: a deployment can wire its `beforeSwapDecision` behind a v4 `beforeSwap` hook surface and pass the PoolManager address at construction. |
| `contracts/v4/AdaptiveFeeHookV4.sol` + `contracts/v4/AdaptiveFeeMathV4.sol` | Real `IHooks` implementation. Inherits `BaseHook` directly, mined CREATE2 hook address with the right permission bits, dispatched by the v4 PoolManager on `beforeSwap` and `afterInitialize`. Returns a per-swap LP fee through the `OVERRIDE_FEE_FLAG` mechanism — i.e. uses the v4 dynamic-fee path end-to-end. Already deployed to X Layer testnet (see below). |

The hackathon rules allow continued development on submitted projects, including new Hook contract logic — both trees above are the result of that follow-on work.

## The hook in one diagram (V4 path)

```
Trader ──► PoolSwapTest.swap(poolKey, ...)
            │
            ▼
       PoolManager
            │
            ▼ beforeSwap callback
   AdaptiveFeeHookV4
            │
            │  ┌─ read poolManager.getSlot0(pid)      → currentTick
            │  ├─ read poolManager.getLiquidity(pid)  → estimate imbalance
            │  ├─ stored referenceTick[pid]
            │  └─ stored cooldownUntilBlock[pid]
            ▼
   AdaptiveFeeMathV4.decide(cfg, ...)
            │
            ▼
   feeBps | OVERRIDE_FEE_FLAG  ──► PoolManager applies this as the LP fee for this swap
```

The pool MUST be created with `PoolKey.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG` (`0x800000`) so the manager honours the hook-returned fee.

## Fee model

`AdaptiveFeeMathV4.decide` (and the analogous `AdaptiveFeeMath.decide` in the MVP tree) is a pure function. Every coefficient that shapes the response curve is per-pool configurable:

```
fee = baseFeeBps
    + (deviation ≥ volatilityThresholdTicks
         ? volatilitySurchargeBaseBps + slope·(deviation − threshold) / scale
         : 0)
    + (pressureDir ≠ 0 ∧ |amount| ≥ imbalanceMinAmount ∧ score ≥ imbalanceThresholdBps
         ? imbalanceSurchargeBps
         : 0)
    + (cooldownActive ? cooldownSurchargeBps : 0)

clamp(fee, [minFeeBps, maxFeeBps])
enterCooldown ⇔ deviation ≥ volatilityThresholdTicks · cooldownTriggerMultiplier
```

Reason flags emitted on each decision:

- `1` — volatility surcharge applied
- `2` — imbalance / pressure surcharge applied
- `4` — cooldown surcharge applied
- `8` — fee was clamped to `maxFeeBps`
- `16` — fee was clamped to `minFeeBps`

Why this is more than "fee = f(volatility)":

- **Imbalance branch** taxes large one-sided pressure separately from volatility, so a sudden whale swap pays even when the tick has barely moved yet.
- **Cooldown branch** is sticky: once a single extreme move trips the circuit breaker, subsequent swaps in the protection window all pay the cooldown surcharge.
- **Reference tick** is anchored at pool initialization and can be re-anchored by the owner, so volatility is measured against a meaningful baseline rather than the previous block.

Every decision emits `FeeDecisionRecorded(poolId, zeroForOne, amount, feeBps, reasonFlags, regime, volatilityScore, imbalanceScoreBps)` so judges (and graphs) can attribute each fee to the signals that produced it.

## Why this hook design earns the "adaptive" label

Other dynamic-fee hooks on v4 generally react to one signal (TWAP-vs-spot volatility, or just swap size). This one fuses three signals plus a stateful circuit breaker, with every coefficient configurable per-pool — so the same hook serves a stable pair and a memecoin pair without redeployment.

## Build & test

```bash
npm install
npm test                    # hardhat: real Solidity tests for the MVP tree
npm run test:mirror         # mocha: JS-mirror sanity check for AdaptiveFeeMathV4
npm run compile             # solc-js, compiles contracts/ + contracts/v4/ together
npm run compile:hardhat     # hardhat compile (used on CI / Linux dev boxes)
```

The MVP-tree tests under `test/adaptiveFeeHook.test.js` and `test/adaptiveFeeMath.test.js` deploy `AdaptiveFeeMathHarness` and `AdaptiveFeeHook` to the in-memory Hardhat network and assert directly against the compiled bytecode (no JS mirror), covering access-control paths (`onlyOwner`, `onlyPoolAdmin`, `onlyPoolManager`) and cooldown state transitions.

**Toolchain note.** The primary dev box is Windows ARM64. Hardhat 2.x's napi-rs Solidity parser and Foundry both ship without `win32-arm64-msvc` prebuilt binaries, so the V4 path uses `solc-js` directly for compilation (`scripts/compile.js`) and `ethers v6` for deployment (`scripts/deploy.js`). On-chain behaviour for the V4 hook is verified by running the deploy script against X Layer testnet rather than a local fork. The Hardhat-driven tests for the MVP tree run unchanged on CI (`.github/workflows/test.yml`) where Linux binaries are available.

## Deploy to X Layer

```bash
export DEPLOYER_PK=0x...           # funded with testnet OKB from https://www.okx.com/en-us/xlayer/faucet
# Optional override if the default RPC is rate-limited:
# export XLAYER_TESTNET_RPC=https://testrpc.xlayer.tech/terigon

npm run compile
npm run deploy:xlayer-testnet
```

`scripts/deploy.js` will, in one go:

1. Deploy `Create2Deployer` (used to mine a hook address with the required `BEFORE_SWAP + AFTER_INITIALIZE` flag bits).
2. Deploy a fresh `PoolManager` (v4-core does not yet have an official X Layer deployment).
3. Deploy two `TestERC20`s, plus `PoolSwapTest` and `PoolModifyLiquidityTest` routers.
4. Mine a CREATE2 salt and deploy `AdaptiveFeeHookV4` at the resulting address.
5. Call `configurePool`, then `PoolManager.initialize(poolKey, sqrtPriceX96)` with `fee = DYNAMIC_FEE_FLAG`.
6. Add initial liquidity around tick 0.
7. Execute three smoke swaps — `calm`, `volatile`, `imbalance` — each printing the fee branch the hook took.
8. Write the address + tx-hash report to `deployments/<chain-label>.json`.

For X Layer mainnet, use `npm run deploy:xlayer-mainnet` and set `XLAYER_RPC` if needed.

## Deployment artifacts (X Layer testnet)

Deployed and exercised on **X Layer testnet** (chainId `1952`) on 2026-05-26. Full report in [`deployments/xlayer-testnet.json`](deployments/xlayer-testnet.json).

| Contract | Address |
|---|---|
| **AdaptiveFeeHookV4** | [`0x7dc7134D7D8E04A241b12CDe10680b76108fD080`](https://www.oklink.com/xlayer-test/address/0x7dc7134D7D8E04A241b12CDe10680b76108fD080) |
| PoolManager (v4-core) | [`0xA6be15bA3f5C6f2D27FBB672f9A5231F735be969`](https://www.oklink.com/xlayer-test/address/0xA6be15bA3f5C6f2D27FBB672f9A5231F735be969) |
| Create2Deployer | [`0xfca6D4417C01572942697CB74D5E7aD68F6da054`](https://www.oklink.com/xlayer-test/address/0xfca6D4417C01572942697CB74D5E7aD68F6da054) |
| PoolSwapTest | [`0xF753F9777f55b42e93bffFCc2BBE003843b64e36`](https://www.oklink.com/xlayer-test/address/0xF753F9777f55b42e93bffFCc2BBE003843b64e36) |
| PoolModifyLiquidityTest | [`0x1A93362885D4a796d85bB2C8EBAcE348f2534CDA`](https://www.oklink.com/xlayer-test/address/0x1A93362885D4a796d85bB2C8EBAcE348f2534CDA) |
| TestERC20 currency0 | [`0x5211769A43D40864de6995A29076e56B26e84AeA`](https://www.oklink.com/xlayer-test/address/0x5211769A43D40864de6995A29076e56B26e84AeA) |
| TestERC20 currency1 | [`0x8F3e5A0a018c255A0400d088863A281fdc1cbE03`](https://www.oklink.com/xlayer-test/address/0x8F3e5A0a018c255A0400d088863A281fdc1cbE03) |

**Pool key:** `currency0 / currency1` with `fee = 0x800000` (DYNAMIC_FEE_FLAG), `tickSpacing = 60`, `hooks = AdaptiveFeeHookV4`.

**Key transactions:**

| Action | tx hash |
|---|---|
| `Create2Deployer.deploy` (CREATE2 mints hook) | [`0x1c65b339…`](https://www.oklink.com/xlayer-test/tx/0x1c65b339dcd7e91f076362a48ed364cfc7da258b196dbc029c9e66d3ebe7b321) |
| `AdaptiveFeeHookV4.configurePool` | [`0x732febe2…`](https://www.oklink.com/xlayer-test/tx/0x732febe269715f3f00933ec871e72fd5412c5ceb15ccf01222cdb3ad8db79a2a) |
| `PoolManager.initialize` (afterInitialize fires) | [`0xd7f4de99…`](https://www.oklink.com/xlayer-test/tx/0xd7f4de997aa3ba55904b48ce374bafec1e16607686b11774812e4630178a8373) |
| `modifyLiquidity` | [`0x1ad7030a…`](https://www.oklink.com/xlayer-test/tx/0x1ad7030a54ff7bc58d6c1a367ff6826e30b3b67e7f762ab00c5072694aaa66a4) |
| Smoke swap #1 (calm, base fee) | [`0x87068811…`](https://www.oklink.com/xlayer-test/tx/0x8706881112dd4d7cc021d2ad3200245215bd1b57749cb0384b9ee5974ed44439) |
| Smoke swap #2 (large swap, hook saw deviation pre-execution) | [`0x74689917…`](https://www.oklink.com/xlayer-test/tx/0x74689917f3f11eee106094323411095cbdcc39758b9da5a7190fab7565bcf3bd) |
| Smoke swap #3 (deviation=199, **VOL branch**, fee=12966 bps) | [`0xb5c7a257…`](https://www.oklink.com/xlayer-test/tx/0xb5c7a25764b60c94baf04359fa2348173be50c7afa8a6b99b7a01da0e8f93ef3) |

**Additional swap txs from `scripts/extra-swaps.js`** (run against the same pool to drive every remaining fee branch onto chain):

| Action | tx hash |
|---|---|
| Extra swap #1 — large zeroForOne, deviation = 296, **VOL branch**, also trips `enterCooldown` | [`0x490a17fa…`](https://www.oklink.com/xlayer-test/tx/0x490a17fa6ac075f933546776dacbe58cd949842750d9824d9b064dd29f79d8d1) |
| `resetReferenceTick` (owner re-anchors deviation back to 0) | [`0x91e041b8…`](https://www.oklink.com/xlayer-test/tx/0x91e041b8030786dfe5aee95abed51aa9a7e720520435a8aff738bbe8c1d79662) |
| Extra swap #2 — large amount/liquidity ratio, **IMB branch + still inside CD window** | [`0x0856f2da…`](https://www.oklink.com/xlayer-test/tx/0x0856f2dad64b223fb63d99061690bc72968a56f270b792a43eefd9777a46735e) |

`FeeDecisionRecorded` events from all five fee decisions on this pool (decoded):

```
calm       feeBps= 3000   regime=calm      volScore=  0  imbScore=    0   flags=[]
swap #2    feeBps= 3000   regime=calm      volScore=  1  imbScore=  100   flags=[]
swap #3    feeBps=12966   regime=volatile  volScore=199  imbScore=   50   flags=[VOL]
extra #1   feeBps=16200   regime=volatile  volScore=296  imbScore=    0   flags=[VOL]
extra #2   feeBps=10500   regime=calm      volScore=  0  imbScore= 2000   flags=[IMB | CD]
```

How to read it:

- **base** (no surcharge) — `calm` and `swap #2` both saw `deviation < threshold` *at entry*, so the hook returned `baseFeeBps = 3000`. (Swap #2 was a large swap that *moved* the tick a lot, but the hook evaluates state pre-execution; this is the intended design — see Security & trust model below.)
- **VOL** — `swap #3` and `extra #1` saw `deviation ≥ 50`. For `extra #1` deviation = 296, surcharge = `5000 + ⌊(296 − 50) × 100 / 3⌋ = 13200`, total fee = `3000 + 13200 = 16200 bps = 1.62%`. ✅
- **CD** — `extra #1` had `deviation ≥ 4 × 50 = 200`, so it called `cooldownUntilBlock[pid] = block + 5`. Two blocks later, `extra #2` saw `cooldownActive = true` and added `cooldownSurchargeBps = 2500`.
- **IMB** — `extra #2`'s `amountSpecified ≈ 2e20` against ~1e21 of liquidity gives `imbScore = 2000 ≥ imbalanceThresholdBps = 1500`, adding `imbalanceSurchargeBps = 5000`. Total: `3000 (base) + 5000 (IMB) + 2500 (CD) = 10500 bps = 1.05%`. ✅

This is the full evidence trail for the four reason-flag branches the hook can take. All five events were emitted by the deployed `AdaptiveFeeHookV4` contract at `0x7dc7…D080` and are decodable from the linked tx receipts on X Layer testnet.

## Security & trust model

- `configurePool` and `resetReferenceTick` on `AdaptiveFeeHookV4` are `onlyOwner` (set explicitly via constructor parameter, so the wallet that triggered the CREATE2 deploy ends up as owner — not the CREATE2 proxy). The MVP tree adds `onlyPoolAdmin` for per-pool config delegation and `onlyPoolManager` to gate the swap callback. External callers cannot push the hook into cooldown or rewrite the fee curve.
- All swap-time inputs to `AdaptiveFeeHookV4` come from `PoolManager` callbacks (the `onlyPoolManager` modifier inherited from `BaseHook` rejects spoofed calls), so the imbalance score and current tick reflect actual pool state, not user-supplied numbers.
- The hook does **not** take `BeforeSwapDelta` and does **not** rebalance the swap itself — it only mutates the LP fee. This keeps the audit surface narrow and the user's swap outcome identical to a vanilla pool aside from the fee.
- Fees are clamped to `[minFeeBps, maxFeeBps]`. Even a misconfigured curve cannot exceed the configured ceiling.
- **State is evaluated pre-execution.** The fee a swap pays reflects pool state *as the swap enters*, not its execution outcome. Two consequences: (a) traders can predict their fee exactly from pre-trade state, which is MEV-resistant (a bot can't simultaneously cause volatility *and* dodge the surcharge in one tx); and (b) cooldown protection appears one swap later than the swap that triggered it.

## Repository map

```
contracts/
├─ AdaptiveFeeHook.sol         (hardened MVP — onlyOwner/onlyPoolAdmin gating, parameterised)
├─ AdaptiveFeeMath.sol         (hardened MVP — pure fee math, parameterised)
├─ test/AdaptiveFeeMathHarness.sol  (test-only wrapper for exercising the lib under Hardhat)
└─ v4/
   ├─ AdaptiveFeeHookV4.sol    (real IHooks implementation, BaseHook-derived)
   ├─ AdaptiveFeeMathV4.sol    (parameterised fee math, V4 path)
   ├─ Create2Deployer.sol      (minimal CREATE2 deployer for hook-address mining)
   └─ Imports.sol              (forces solc to compile v4-core PoolManager + test routers)
scripts/
├─ compile.js                  (solc-js compiler with node_modules import resolution)
├─ hookMiner.js                (CREATE2 salt search — JS port of Foundry HookMiner)
├─ mine.js                     (self-test for hookMiner)
├─ deploy.js                   (end-to-end deployment + smoke-swap script, V4 path)
├─ extra-swaps.js              (follow-up swaps to drive every fee branch on chain)
└─ demo.js                     (Hardhat-driven MVP demo)
test/
├─ adaptiveFeeHook.test.js     (Hardhat tests for the MVP hook — access control, cooldown)
├─ adaptiveFeeMath.test.js     (Hardhat tests for the MVP fee math)
└─ adaptiveFeeMathV4.test.js   (mocha JS-mirror tests for the V4 fee math)
.github/workflows/             (CI: hardhat compile + test on push/PR)
deployments/                   (deployment reports per chain — kept in repo as evidence)
docs/superpowers/              (planning + design docs from the submitted MVP)
```

## Acknowledgements

- Built on `@uniswap/v4-core` and `@uniswap/v4-periphery`.
- Hackathon track: [OKX X Layer Build-X — Hook](https://web3.okx.com/xlayer/build-x-hackathon/hook), with Uniswap and Flap.
- HookMiner salt-search logic is a JS port of `v4-periphery`'s Foundry library, adapted for `ethers v6`.
