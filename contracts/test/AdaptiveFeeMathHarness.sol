// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdaptiveFeeMath} from "../AdaptiveFeeMath.sol";

contract AdaptiveFeeMathHarness {
    function decide(
        AdaptiveFeeMath.Config memory config,
        int24 referenceTick,
        int24 currentTick,
        int256 amountSpecified,
        int256 imbalance,
        int8 pressureDirection,
        bool cooldownActive
    ) external pure returns (AdaptiveFeeMath.Decision memory) {
        return AdaptiveFeeMath.decide(
            config,
            referenceTick,
            currentTick,
            amountSpecified,
            imbalance,
            pressureDirection,
            cooldownActive
        );
    }

    function validate(AdaptiveFeeMath.Config memory config) external pure {
        AdaptiveFeeMath.validate(config);
    }
}
