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
    }

    function _absTickDiff(int24 a, int24 b) private pure returns (uint24) {
        int256 diff = int256(a) - int256(b);
        if (diff < 0) {
            diff = -diff;
        }
        return uint24(uint256(diff));
    }
}
