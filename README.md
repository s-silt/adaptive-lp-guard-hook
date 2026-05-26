# Adaptive LP Guard Hook

Adaptive LP Guard Hook is a compact Uniswap v4-style Hook MVP for the X Layer Build X Hook hackathon. It adapts swap fees to volatility, swap pressure, and pool imbalance so LPs get more protection when market conditions become hostile.

The design borrows from `aster-trading-bot` patterns:

- Regime detection: calm versus volatile pool state.
- Risk throttling: higher fees when risk indicators rise.
- Circuit breaker behavior: extreme tick deviation activates cooldown protection.
- Attribution events: each decision records fee, regime, scores, and reason flags.

## Contracts

- `contracts/AdaptiveFeeMath.sol`: pure fee decision library.
- `contracts/AdaptiveFeeHook.sol`: stateful hook-facing contract with pool config, per-pool admin, cooldown state, and decision events. Only the configured `poolManager` can call `beforeSwapDecision`; only the owner (or the pool's admin) can call `configurePool`.
- `contracts/test/AdaptiveFeeMathHarness.sol`: test-only wrapper that exposes the library functions so Hardhat tests exercise the real Solidity rather than a JS mirror.

`AdaptiveFeeHook.beforeSwapDecision` is intentionally small and adapter-friendly. A full Uniswap v4 deployment can wire the same decision engine into the real `beforeSwap` hook surface and pass the PoolManager address as `poolManager` at construction time.

## Fee Model

The hook starts from `baseFeeBps`, then:

1. Adds `volatilityFeeBps + over/volatilitySlopeDivisor` when `abs(currentTick - referenceTick)` exceeds `volatilityThresholdTicks`.
2. Adds `pressureFeeBps` when a large swap (`|amountSpecified| >= largeSwapThreshold`) arrives in the same direction as a significant imbalance (`|imbalance| >= imbalanceThreshold`, same sign as `pressureDirection`).
3. Adds `cooldownFeeBps` while the pool is in protection mode.
4. Clamps the final result between `minFeeBps` and `maxFeeBps`.

A swap triggers cooldown when `abs(currentTick - referenceTick) >= volatilityThresholdTicks * cooldownTriggerMultiplier`; protection lasts for `cooldownBlocks` blocks.

Reason flags:

- `1`: volatility surcharge
- `2`: pressure / imbalance surcharge
- `4`: cooldown surcharge
- `8`: max-fee clamp

All knobs (`volatilityFeeBps`, `volatilitySlopeDivisor`, `largeSwapThreshold`, `imbalanceThreshold`, `pressureFeeBps`, `cooldownFeeBps`, `cooldownTriggerMultiplier`, `cooldownBlocks`) live in `AdaptiveFeeMath.Config` so each pool can tune them independently.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

Tests run under Hardhat: the suite deploys `AdaptiveFeeMathHarness` and `AdaptiveFeeHook` to the in-memory Hardhat network and asserts directly against the compiled bytecode. Access-control paths (`onlyOwner`, `onlyPoolAdmin`, `onlyPoolManager`) and cooldown state transitions are covered in `test/adaptiveFeeHook.test.js`; the pure fee math is covered in `test/adaptiveFeeMath.test.js`.

## Demo

```bash
npm run demo
```

The demo script deploys the hook locally, configures a demo pool, and prints decisions for calm, volatile, same-direction pressure, and cooldown-protected swaps. Example output:

```text
calm swap: fee=30bps regime=calm volatilityTicks=10 imbalance=0 flags=0
volatile swap: fee=105bps regime=volatile volatilityTicks=125 imbalance=0 flags=1
same-direction pressure: fee=80bps regime=calm volatilityTicks=10 imbalance=2500 flags=2
cooldown protected swap: fee=55bps regime=calm volatilityTicks=10 imbalance=0 flags=4
```

## X Layer Deployment Path

1. Add a real Uniswap v4 hook adapter around `AdaptiveFeeMath.decide`.
2. Deploy `AdaptiveFeeHook` to X Layer testnet or mainnet, passing the v4 PoolManager address as the constructor argument.
3. Create a v4 pool that points at the hook address.
4. Call `configurePool` from the owner (or a designated pool admin) to install fee parameters for that pool.
5. Submit the pool address, hook address, source code, and demo video to the hackathon form.

## Hackathon Narrative

Most dynamic-fee hooks react only to volatility. Adaptive LP Guard also considers swap pressure and cooldown state, which makes it closer to a live risk engine. The MVP is small enough to audit but expressive enough to show how LP protection can become programmable at the pool level.
