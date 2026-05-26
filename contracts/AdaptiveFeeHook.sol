// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdaptiveFeeMath} from "./AdaptiveFeeMath.sol";

contract AdaptiveFeeHook {
    using AdaptiveFeeMath for AdaptiveFeeMath.Config;

    struct FeeDecision {
        uint16 feeBps;
        uint16 reasonFlags;
        uint8 regime;
        uint24 volatilityScore;
        uint256 imbalanceScore;
    }

    address public owner;
    address public immutable poolManager;

    mapping(bytes32 poolId => AdaptiveFeeMath.Config config) private _configs;
    mapping(bytes32 poolId => bool ready) public isConfigured;
    mapping(bytes32 poolId => address admin) public poolAdmin;
    mapping(bytes32 poolId => uint256 blockNumber) public cooldownUntilBlock;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PoolAdminSet(bytes32 indexed poolId, address indexed admin);
    event PoolConfigured(bytes32 indexed poolId, AdaptiveFeeMath.Config config);
    event CooldownActivated(bytes32 indexed poolId, uint256 untilBlock);
    event FeeDecisionRecorded(
        bytes32 indexed poolId,
        uint16 feeBps,
        uint16 reasonFlags,
        uint8 regime,
        uint24 volatilityScore,
        uint256 imbalanceScore
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyPoolAdmin(bytes32 poolId) {
        require(
            msg.sender == owner || msg.sender == poolAdmin[poolId],
            "not pool admin"
        );
        _;
    }

    modifier onlyPoolManager() {
        require(msg.sender == poolManager, "not pool manager");
        _;
    }

    constructor(address _poolManager) {
        require(_poolManager != address(0), "zero pool manager");
        owner = msg.sender;
        poolManager = _poolManager;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setPoolAdmin(bytes32 poolId, address admin) external onlyOwner {
        require(admin != address(0), "zero admin");
        poolAdmin[poolId] = admin;
        emit PoolAdminSet(poolId, admin);
    }

    function configurePool(bytes32 poolId, AdaptiveFeeMath.Config calldata config)
        external
        onlyPoolAdmin(poolId)
    {
        AdaptiveFeeMath.Config memory stored = config;
        stored.validate();
        _configs[poolId] = stored;
        isConfigured[poolId] = true;
        emit PoolConfigured(poolId, config);
    }

    function getConfig(bytes32 poolId)
        external
        view
        returns (AdaptiveFeeMath.Config memory)
    {
        return _configs[poolId];
    }

    function beforeSwapDecision(
        bytes32 poolId,
        int24 referenceTick,
        int24 currentTick,
        int256 amountSpecified,
        int256 imbalance,
        int8 pressureDirection
    ) external onlyPoolManager returns (FeeDecision memory result) {
        require(isConfigured[poolId], "pool not configured");
        AdaptiveFeeMath.Config memory config = _configs[poolId];

        AdaptiveFeeMath.Decision memory decision = AdaptiveFeeMath.decide(
            config,
            referenceTick,
            currentTick,
            amountSpecified,
            imbalance,
            pressureDirection,
            block.number <= cooldownUntilBlock[poolId]
        );

        if (decision.enterCooldown && config.cooldownBlocks > 0) {
            uint256 untilBlock = block.number + config.cooldownBlocks;
            cooldownUntilBlock[poolId] = untilBlock;
            emit CooldownActivated(poolId, untilBlock);
        }

        result = FeeDecision({
            feeBps: decision.feeBps,
            reasonFlags: decision.reasonFlags,
            regime: decision.regime,
            volatilityScore: decision.volatilityScore,
            imbalanceScore: decision.imbalanceScore
        });

        emit FeeDecisionRecorded(
            poolId,
            result.feeBps,
            result.reasonFlags,
            result.regime,
            result.volatilityScore,
            result.imbalanceScore
        );
    }
}
