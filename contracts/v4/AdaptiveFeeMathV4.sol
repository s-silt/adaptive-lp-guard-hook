// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AdaptiveFeeMathV4
/// @notice Pure fee decision engine with fully parameterized response curve.
/// @dev All response coefficients are per-pool configurable, so the "adaptive"
///      properties can be tuned per asset pair without redeploying the hook.
library AdaptiveFeeMathV4 {
    uint8 internal constant REGIME_CALM = 0;
    uint8 internal constant REGIME_VOLATILE = 1;

    uint16 internal constant FLAG_VOLATILITY = 1;
    uint16 internal constant FLAG_IMBALANCE = 2;
    uint16 internal constant FLAG_COOLDOWN = 4;
    uint16 internal constant FLAG_CLAMPED_MAX = 8;
    uint16 internal constant FLAG_CLAMPED_MIN = 16;

    struct Config {
        // Base envelope
        uint24 baseFeeBps;
        uint24 minFeeBps;
        uint24 maxFeeBps;
        // Volatility response: surcharge = base + slope * (deviation - threshold) / scale
        uint24 volatilityThresholdTicks;
        uint24 volatilitySurchargeBaseBps;
        uint24 volatilitySurchargeSlopeBps;
        uint24 volatilitySurchargeScale;
        // Imbalance response: flat surcharge when score >= threshold and amount >= minSize
        uint24 imbalanceThresholdBps;
        uint24 imbalanceSurchargeBps;
        uint256 imbalanceMinAmount;
        // Cooldown response: enter when deviation >= threshold * trigger; flat surcharge while active
        uint16 cooldownTriggerMultiplier;
        uint32 cooldownBlocks;
        uint24 cooldownSurchargeBps;
        // Reference-tick EMA: weights applied to `currentTick` when smoothing the
        // stored anchor after a swap. Each is in bps (0..10_000).
        //   0     → anchor stays frozen (legacy v1/v2 behaviour, owner must re-anchor manually)
        //   10000 → anchor snaps to currentTick on every swap (no protection)
        // Two weights so the policy can be **regime-adaptive**: typically users want a
        // bigger weight when the pool is calm (anchor should track baseline drift) and
        // a smaller weight while a cooldown is active (don't let a whale poison the anchor).
        uint16 referenceTickEmaWeightCalmBps;
        uint16 referenceTickEmaWeightVolatileBps;
    }

    struct Decision {
        uint24 feeBps;
        uint16 reasonFlags;
        uint8 regime;
        uint24 volatilityScore;
        uint16 imbalanceScoreBps;
        bool enterCooldown;
    }

    function decide(
        Config memory config,
        int24 referenceTick,
        int24 currentTick,
        uint256 amountSpecifiedAbs,
        uint16 imbalanceScoreBps,
        int8 pressureDirection,
        bool cooldownActive
    ) internal pure returns (Decision memory decision) {
        uint24 deviation = _absTickDiff(referenceTick, currentTick);
        uint256 fee = config.baseFeeBps;
        decision.volatilityScore = deviation;
        decision.imbalanceScoreBps = imbalanceScoreBps;

        if (deviation >= config.volatilityThresholdTicks) {
            uint256 overThreshold = uint256(deviation) - uint256(config.volatilityThresholdTicks);
            uint256 scale = config.volatilitySurchargeScale == 0 ? 1 : config.volatilitySurchargeScale;
            uint256 volatilitySurcharge =
                uint256(config.volatilitySurchargeBaseBps) + (overThreshold * config.volatilitySurchargeSlopeBps) / scale;
            fee += volatilitySurcharge;
            decision.reasonFlags |= FLAG_VOLATILITY;
            decision.regime = REGIME_VOLATILE;
        } else {
            decision.regime = REGIME_CALM;
        }

        if (
            pressureDirection != 0
                && amountSpecifiedAbs >= config.imbalanceMinAmount
                && imbalanceScoreBps >= config.imbalanceThresholdBps
        ) {
            fee += config.imbalanceSurchargeBps;
            decision.reasonFlags |= FLAG_IMBALANCE;
        }

        if (cooldownActive) {
            fee += config.cooldownSurchargeBps;
            decision.reasonFlags |= FLAG_COOLDOWN;
        }

        if (fee < config.minFeeBps) {
            fee = config.minFeeBps;
            decision.reasonFlags |= FLAG_CLAMPED_MIN;
        }
        if (fee > config.maxFeeBps) {
            fee = config.maxFeeBps;
            decision.reasonFlags |= FLAG_CLAMPED_MAX;
        }

        decision.feeBps = uint24(fee);
        decision.enterCooldown =
            deviation >= uint256(config.volatilityThresholdTicks) * config.cooldownTriggerMultiplier;
    }

    function validate(Config memory config) internal pure {
        require(config.minFeeBps <= config.baseFeeBps, "min above base");
        require(config.baseFeeBps <= config.maxFeeBps, "base above max");
        require(config.maxFeeBps <= 1_000_000, "fee above 100%");
        require(config.volatilityThresholdTicks > 0, "zero volatility threshold");
        require(config.volatilitySurchargeScale > 0, "zero volatility scale");
        require(config.imbalanceThresholdBps <= 10_000, "bad imbalance threshold");
        require(config.cooldownTriggerMultiplier > 0, "zero cooldown multiplier");
        require(config.referenceTickEmaWeightCalmBps <= 10_000, "bad ema calm");
        require(config.referenceTickEmaWeightVolatileBps <= 10_000, "bad ema vol");
        // Sanity: volatile weight should never exceed calm weight. A pool that
        // updates its anchor *faster* during volatility makes no protection sense.
        require(
            config.referenceTickEmaWeightVolatileBps <= config.referenceTickEmaWeightCalmBps,
            "ema vol > ema calm"
        );
    }

    /// @notice Compute the new reference tick after a swap, smoothing the stored
    ///         anchor toward `currentTick` using an EMA whose weight depends on
    ///         whether the pool is currently in a cooldown window.
    ///
    /// @dev    This is intentionally separated from `decide()` so the hook can
    ///         call it from `_afterSwap` with the **post-swap** tick. That way
    ///         the anchor follows the realised price, not the predicted one.
    ///
    /// @dev    Design space the caller is choosing between via the two weights:
    ///         - Set both weights = 0   → anchor freezes (v1/v2 behaviour)
    ///         - Set both weights = N   → uniform EMA, drifts under whales
    ///         - calm > 0, volatile = 0 → strict: anchor only updates between events
    ///         - calm > volatile > 0    → smooth: anchor still tracks during stress, just slower
    ///         Whatever the policy, the formula MUST produce a tick `newRef` such that:
    ///           min(referenceTick, currentTick) <= newRef <= max(referenceTick, currentTick)
    ///         i.e. EMA never overshoots — see `_clampBetween` below.
    function updateAnchor(
        Config memory config,
        int24 referenceTick,
        int24 currentTick,
        bool cooldownActive
    ) internal pure returns (int24 newReferenceTick) {
        uint16 weightBps = cooldownActive
            ? config.referenceTickEmaWeightVolatileBps
            : config.referenceTickEmaWeightCalmBps;

        if (weightBps == 0 || referenceTick == currentTick) {
            return referenceTick;
        }
        if (weightBps == 10_000) {
            return currentTick;
        }

        // Policy: "Option A" — anchor always drifts toward currentTick by at least 1 tick
        // when they differ. Truncation-to-zero would leave the anchor permanently stuck
        // under small weights (e.g. weightBps=500, diff=10 → step=0). Forcing ±1 in that
        // case means even a 1% weight tracks slow drift one tick at a time.
        int256 diff = int256(currentTick) - int256(referenceTick);
        int256 step = (diff * int256(uint256(weightBps))) / int256(10_000);
        if (step == 0) {
            step = diff > 0 ? int256(1) : int256(-1);
        }
        int256 proposed = int256(referenceTick) + step;
        return _clampBetween(referenceTick, currentTick, int24(proposed));
    }

    /// @dev Guarantees the EMA result stays within [min(a,b), max(a,b)]. Defensive against
    ///      any caller-side arithmetic bug — anchor must never escape the segment.
    function _clampBetween(int24 a, int24 b, int24 x) private pure returns (int24) {
        (int24 lo, int24 hi) = a < b ? (a, b) : (b, a);
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

    function _absTickDiff(int24 a, int24 b) private pure returns (uint24) {
        int256 diff = int256(a) - int256(b);
        if (diff < 0) {
            diff = -diff;
        }
        return uint24(uint256(diff));
    }
}
