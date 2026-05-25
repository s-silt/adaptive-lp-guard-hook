# Adaptive LP Guard Hook

Adaptive LP Guard Hook is a compact Uniswap v4-style Hook MVP for the X Layer Build X Hook hackathon. It adapts swap fees to volatility, swap pressure, and pool imbalance so LPs get more protection when market conditions become hostile.

The design borrows from `aster-trading-bot` patterns:

- Regime detection: calm versus volatile pool state.
- Risk throttling: higher fees when risk indicators rise.
- Circuit breaker behavior: extreme tick deviation activates cooldown protection.
- Attribution events: each decision records fee, regime, scores, and reason flags.

## Contracts

- `contracts/AdaptiveFeeMath.sol`: pure fee decision library.
- `contracts/AdaptiveFeeHook.sol`: stateful hook-facing contract with pool config, cooldown state, and decision events.

`AdaptiveFeeHook.beforeSwapDecision` is intentionally small and adapter-friendly. A full Uniswap v4 deployment can wire the same decision engine into the real `beforeSwap` hook surface.

## Fee Model

The hook starts from `baseFeeBps`, then:

1. Adds a volatility surcharge when `abs(currentTick - referenceTick)` exceeds `volatilityThresholdTicks`.
2. Adds an imbalance surcharge when a large swap arrives in a nonzero pressure direction and imbalance is above threshold.
3. Adds a cooldown surcharge while the pool is in protection mode.
4. Clamps the final result between `minFeeBps` and `maxFeeBps`.

Reason flags:

- `1`: volatility surcharge
- `2`: imbalance surcharge
- `4`: cooldown surcharge
- `8`: max-fee clamp

## Install

```bash
npm install
```

## Test

```bash
npm test
```

The test suite compiles the Solidity contracts with `solc-js` and validates the same fee scenarios through a JavaScript mirror of the on-chain fee model. This avoids native local-chain dependencies on Windows ARM64 while still checking Solidity compilation and the model behavior.

## Demo

```bash
npm run demo
```

Example output:

```text
calm swap: fee=30bps regime=calm volatilityTicks=10 imbalance=0 flags=0
volatile swap: fee=105bps regime=volatile volatilityTicks=125 imbalance=0 flags=1
large same-direction pressure: fee=80bps regime=calm volatilityTicks=10 imbalance=2500 flags=2
cooldown protected swap: fee=55bps regime=calm volatilityTicks=10 imbalance=0 flags=4
```

## X Layer Deployment Path

1. Add a real Uniswap v4 hook adapter around `AdaptiveFeeMath.decide`.
2. Deploy the hook adapter to X Layer testnet or mainnet.
3. Create a v4 pool using the hook address.
4. Submit the pool address, hook address, source code, and demo video to the hackathon form.

## Hackathon Narrative

Most dynamic-fee hooks react only to volatility. Adaptive LP Guard also considers swap pressure and cooldown state, which makes it closer to a live risk engine. The MVP is small enough to audit but expressive enough to show how LP protection can become programmable at the pool level.
