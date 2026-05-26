// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library AdaptiveFeeMath {
    uint8 internal constant REGIME_CALM = 0;
    uint8 internal constant REGIME_VOLATILE = 1;

    uint16 internal constant FLAG_VOLATILITY = 1;
    uint16 internal constant FLAG_IMBALANCE = 2;
    uint16 internal constant FLAG_COOLDOWN = 4;
    uint16 internal constant FLAG_CLAMPED_MAX = 8;

    struct Config {
        uint16 minFeeBps;
        uint16 baseFeeBps;
        uint16 maxFeeBps;
        uint24 volatilityThresholdTicks;
        uint16 volatilityFeeBps;
        uint24 volatilitySlopeDivisor;
        uint256 largeSwapThreshold;
        uint256 imbalanceThreshold;
        uint16 pressureFeeBps;
        uint16 cooldownFeeBps;
        uint16 cooldownTriggerMultiplier;
        uint32 cooldownBlocks;
    }

    struct Decision {
        uint16 feeBps;
        uint16 reasonFlags;
        uint8 regime;
        uint24 volatilityScore;
        uint256 imbalanceScore;
        bool enterCooldown;
    }

    function decide(
        Config memory config,
        int24 referenceTick,
        int24 currentTick,
        int256 amountSpecified,
        int256 imbalance,
        int8 pressureDirection,
        bool cooldownActive
    ) internal pure returns (Decision memory decision) {
        uint24 deviation = _absTickDiff(referenceTick, currentTick);
        uint256 absAmount = _abs256(amountSpecified);
        uint256 absImbalance = _abs256(imbalance);

        decision.volatilityScore = deviation;
        decision.imbalanceScore = absImbalance;

        uint256 fee = config.baseFeeBps;

        if (deviation >= config.volatilityThresholdTicks) {
            uint256 overThreshold = uint256(deviation) - uint256(config.volatilityThresholdTicks);
            uint256 surcharge = uint256(config.volatilityFeeBps)
                + (overThreshold / uint256(config.volatilitySlopeDivisor));
            fee += surcharge;
            decision.reasonFlags |= FLAG_VOLATILITY;
            decision.regime = REGIME_VOLATILE;
        } else {
            decision.regime = REGIME_CALM;
        }

        bool sameDirectionPressure =
            (imbalance > 0 && pressureDirection > 0) ||
            (imbalance < 0 && pressureDirection < 0);

        if (
            sameDirectionPressure
                && absAmount >= config.largeSwapThreshold
                && absImbalance >= config.imbalanceThreshold
        ) {
            fee += config.pressureFeeBps;
            decision.reasonFlags |= FLAG_IMBALANCE;
        }

        if (cooldownActive) {
            fee += config.cooldownFeeBps;
            decision.reasonFlags |= FLAG_COOLDOWN;
        }

        if (fee < config.minFeeBps) {
            fee = config.minFeeBps;
        }

        if (fee > config.maxFeeBps) {
            fee = config.maxFeeBps;
            decision.reasonFlags |= FLAG_CLAMPED_MAX;
        }

        decision.feeBps = uint16(fee);

        uint256 cooldownTrigger = uint256(config.volatilityThresholdTicks)
            * uint256(config.cooldownTriggerMultiplier);
        decision.enterCooldown = cooldownTrigger > 0 && uint256(deviation) >= cooldownTrigger;
    }

    function validate(Config memory config) internal pure {
        require(config.minFeeBps <= config.baseFeeBps, "min above base");
        require(config.baseFeeBps <= config.maxFeeBps, "base above max");
        require(config.maxFeeBps <= 10_000, "fee above 100%");
        require(config.volatilityThresholdTicks > 0, "zero volatility threshold");
        require(config.volatilitySlopeDivisor > 0, "zero slope divisor");
    }

    function _absTickDiff(int24 a, int24 b) private pure returns (uint24) {
        int256 diff = int256(a) - int256(b);
        if (diff < 0) {
            diff = -diff;
        }
        return uint24(uint256(diff));
    }

    function _abs256(int256 x) private pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}
