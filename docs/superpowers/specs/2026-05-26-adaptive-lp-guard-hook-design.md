# Adaptive LP Guard Hook Design

## Goal

Build a compact Uniswap v4-style Hook MVP for the X Layer Build X Hook hackathon. The hook protects LPs by adapting swap fees to volatility, swap pressure, and pool imbalance signals inspired by `aster-trading-bot`.

## Scope

The repository ships a Solidity fee decision engine, a hook-facing contract, tests, and deployment/demo documentation. It does not ship a full production oracle, keeper, or UI. The MVP is designed so a real Uniswap v4 integration can replace the lightweight hook adapter without changing the fee math.

## Core Idea

`AdaptiveFeeHook` computes a dynamic fee before a swap:

- Start from a base fee.
- Add a volatility surcharge when current tick deviates from reference tick.
- Add an imbalance surcharge for large swaps that push in the same pressure direction.
- Add a cooldown surcharge when a pool has recently entered protection mode.
- Clamp the result between configured minimum and maximum fees.

The design borrows four bot patterns:

- Regime detection: market state changes the fee response.
- Risk throttling: high-risk states reduce aggressiveness by charging more.
- Circuit breaker: extreme moves enter a short protection window.
- Event attribution: every decision emits inputs and reason flags for demos.

## Contracts

- `contracts/AdaptiveFeeMath.sol`: pure fee calculation and reason flags.
- `contracts/AdaptiveFeeHook.sol`: stores pool config/state and exposes a v4-style `beforeSwapDecision` function for testing and adapters.

## Testing

The test suite verifies:

- Calm swaps return the base fee.
- Volatile tick deviation increases fees.
- Large same-direction swaps add imbalance surcharge.
- Fees are clamped to configured min/max.
- Extreme deviations activate cooldown state and affect subsequent swaps.

## Publishing

Create a public GitHub repository named `adaptive-lp-guard-hook` under the authenticated account and push `main`.
