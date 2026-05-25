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
        uint16 baseFeeBps;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        uint24 volatilityThresholdTicks;
        uint16 imbalanceThresholdBps;
        uint32 cooldownBlocks;
    }

    struct Decision {
        uint16 feeBps;
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
        uint256 amountSpecified,
        uint16 imbalanceScoreBps,
        int8 pressureDirection,
        bool cooldownActive
    ) internal pure returns (Decision memory decision) {
        uint24 deviation = _absTickDiff(referenceTick, currentTick);
        uint256 fee = config.baseFeeBps;
        decision.volatilityScore = deviation;
        decision.imbalanceScoreBps = imbalanceScoreBps;

        if (deviation >= config.volatilityThresholdTicks) {
            uint256 overThreshold = deviation - config.volatilityThresholdTicks;
            uint256 volatilitySurcharge = 50 + (overThreshold / 3);
            fee += volatilitySurcharge;
            decision.reasonFlags |= FLAG_VOLATILITY;
            decision.regime = REGIME_VOLATILE;
        } else {
            decision.regime = REGIME_CALM;
        }

        if (
            pressureDirection != 0
                && amountSpecified >= 1_000
                && imbalanceScoreBps >= config.imbalanceThresholdBps
        ) {
            fee += 50;
            decision.reasonFlags |= FLAG_IMBALANCE;
        }

        if (cooldownActive) {
            fee += 25;
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
        decision.enterCooldown = deviation >= uint256(config.volatilityThresholdTicks) * 4;
    }

    function validate(Config memory config) internal pure {
        require(config.minFeeBps <= config.baseFeeBps, "min above base");
        require(config.baseFeeBps <= config.maxFeeBps, "base above max");
        require(config.maxFeeBps <= 10_000, "fee above 100%");
        require(config.volatilityThresholdTicks > 0, "zero volatility threshold");
        require(config.imbalanceThresholdBps <= 10_000, "bad imbalance threshold");
    }

    function _absTickDiff(int24 a, int24 b) private pure returns (uint24) {
        int256 diff = int256(a) - int256(b);
        if (diff < 0) {
            diff = -diff;
        }
        return uint24(uint256(diff));
    }
}
