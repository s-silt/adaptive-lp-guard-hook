// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdaptiveFeeMath} from "./AdaptiveFeeMath.sol";

contract AdaptiveFeeHook {
    using AdaptiveFeeMath for AdaptiveFeeMath.Config;

    struct PoolConfig {
        uint16 baseFeeBps;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        uint24 volatilityThresholdTicks;
        uint16 imbalanceThresholdBps;
        uint32 cooldownBlocks;
    }

    struct FeeDecision {
        uint16 feeBps;
        uint16 reasonFlags;
        uint8 regime;
        uint24 volatilityScore;
        uint16 imbalanceScoreBps;
    }

    mapping(bytes32 poolId => AdaptiveFeeMath.Config config) private _configs;
    mapping(bytes32 poolId => uint256 blockNumber) public cooldownUntilBlock;

    event PoolConfigured(bytes32 indexed poolId, PoolConfig config);
    event FeeDecisionRecorded(
        bytes32 indexed poolId,
        uint16 feeBps,
        uint16 reasonFlags,
        uint8 regime,
        uint24 volatilityScore,
        uint16 imbalanceScoreBps
    );

    function configurePool(bytes32 poolId, PoolConfig calldata config) external {
        AdaptiveFeeMath.Config memory mathConfig = AdaptiveFeeMath.Config({
            baseFeeBps: config.baseFeeBps,
            minFeeBps: config.minFeeBps,
            maxFeeBps: config.maxFeeBps,
            volatilityThresholdTicks: config.volatilityThresholdTicks,
            imbalanceThresholdBps: config.imbalanceThresholdBps,
            cooldownBlocks: config.cooldownBlocks
        });
        mathConfig.validate();
        _configs[poolId] = mathConfig;
        emit PoolConfigured(poolId, config);
    }

    function beforeSwapDecision(
        bytes32 poolId,
        int24 referenceTick,
        int24 currentTick,
        uint256 amountSpecified,
        uint16 imbalanceScoreBps,
        int8 pressureDirection
    ) external returns (FeeDecision memory result) {
        AdaptiveFeeMath.Config memory config = _configs[poolId];
        config.validate();

        AdaptiveFeeMath.Decision memory decision = AdaptiveFeeMath.decide(
            config,
            referenceTick,
            currentTick,
            amountSpecified,
            imbalanceScoreBps,
            pressureDirection,
            block.number <= cooldownUntilBlock[poolId]
        );

        if (decision.enterCooldown && config.cooldownBlocks > 0) {
            cooldownUntilBlock[poolId] = block.number + config.cooldownBlocks;
        }

        result = FeeDecision({
            feeBps: decision.feeBps,
            reasonFlags: decision.reasonFlags,
            regime: decision.regime,
            volatilityScore: decision.volatilityScore,
            imbalanceScoreBps: decision.imbalanceScoreBps
        });

        emit FeeDecisionRecorded(
            poolId,
            result.feeBps,
            result.reasonFlags,
            result.regime,
            result.volatilityScore,
            result.imbalanceScoreBps
        );
    }
}
