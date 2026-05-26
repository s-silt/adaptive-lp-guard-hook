// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {AdaptiveFeeMathV4} from "./AdaptiveFeeMathV4.sol";

/// @title AdaptiveFeeHookV4
/// @notice Uniswap v4 hook that adapts per-swap LP fee to volatility, swap
///         pressure, and a cooldown-based circuit breaker.
/// @dev Pools that wire this hook MUST be created with PoolKey.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG.
contract AdaptiveFeeHookV4 is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(PoolId poolId => AdaptiveFeeMathV4.Config config) private _configs;
    mapping(PoolId poolId => int24 tick) public referenceTick;
    mapping(PoolId poolId => uint256 blockNumber) public cooldownUntilBlock;

    event PoolConfigured(PoolId indexed poolId, AdaptiveFeeMathV4.Config config);
    event ReferenceTickReset(PoolId indexed poolId, int24 tick);
    event FeeDecisionRecorded(
        PoolId indexed poolId,
        bool zeroForOne,
        int256 amountSpecified,
        uint24 feeBps,
        uint16 reasonFlags,
        uint8 regime,
        uint24 volatilityScore,
        uint16 imbalanceScoreBps
    );
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error NotOwner();
    error NotPendingOwner();
    error PoolNotConfigured();
    error ZeroOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param _manager v4-core PoolManager.
    /// @param _owner   The address allowed to call configurePool / resetReferenceTick.
    ///                 Passed explicitly because hooks are typically deployed via a
    ///                 CREATE2 proxy and msg.sender during construction is the proxy.
    constructor(IPoolManager _manager, address _owner) BaseHook(_manager) {
        if (_owner == address(0)) revert ZeroOwner();
        owner = _owner;
        emit OwnerTransferred(address(0), _owner);
    }

    /// @notice Stop the adaptive surcharges. Swaps still go through but the hook
    ///         returns the configured baseFeeBps with no add-ons. Useful as a kill
    ///         switch if oracle / liquidity reads ever produce nonsense values.
    function emergencyPause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Begin a two-step ownership handover. The new owner must call
    ///         acceptOwner() from the target address before the change takes effect.
    /// @dev Two-step on purpose: a typo in `newOwner` is recoverable here (just
    ///      transferOwner again) but would permanently brick the hook under a
    ///      one-step transfer.
    function transferOwner(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnerTransferStarted(owner, newOwner);
    }

    /// @notice Complete a handover started by transferOwner. Must be called by the
    ///         exact address passed as `newOwner`.
    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        delete pendingOwner;
        emit OwnerTransferred(previous, msg.sender);
    }

    /// @notice Cancel a pending handover before it is accepted.
    function cancelOwnerTransfer() external onlyOwner {
        delete pendingOwner;
        emit OwnerTransferStarted(owner, address(0));
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function getConfig(PoolId poolId) external view returns (AdaptiveFeeMathV4.Config memory) {
        return _configs[poolId];
    }

    function configurePool(PoolKey calldata key, AdaptiveFeeMathV4.Config calldata cfg) external onlyOwner {
        AdaptiveFeeMathV4.validate(cfg);
        PoolId pid = key.toId();
        _configs[pid] = cfg;
        emit PoolConfigured(pid, cfg);
    }

    /// @notice Manual override to re-anchor the reference tick (e.g. after a regime change).
    function resetReferenceTick(PoolKey calldata key) external onlyOwner {
        PoolId pid = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(pid);
        referenceTick[pid] = tick;
        emit ReferenceTickReset(pid, tick);
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        internal
        override
        returns (bytes4)
    {
        PoolId pid = key.toId();
        referenceTick[pid] = tick;
        emit ReferenceTickReset(pid, tick);
        return BaseHook.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId pid = key.toId();
        AdaptiveFeeMathV4.Config memory config = _configs[pid];
        if (config.maxFeeBps == 0) revert PoolNotConfigured();

        // Pause path: skip all adaptive logic, return baseFee with override flag.
        if (paused) {
            return (
                BaseHook.beforeSwap.selector,
                BeforeSwapDeltaLibrary.ZERO_DELTA,
                uint24(config.baseFeeBps) | LPFeeLibrary.OVERRIDE_FEE_FLAG
            );
        }

        (, int24 currentTick,,) = poolManager.getSlot0(pid);
        uint128 liquidity = poolManager.getLiquidity(pid);

        uint256 absAmount = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);
        uint16 imbalanceScoreBps = _estimateImbalance(absAmount, liquidity);
        int8 pressureDir = params.zeroForOne ? int8(1) : int8(-1);

        AdaptiveFeeMathV4.Decision memory decision = AdaptiveFeeMathV4.decide(
            config,
            referenceTick[pid],
            currentTick,
            absAmount,
            imbalanceScoreBps,
            pressureDir,
            block.number <= cooldownUntilBlock[pid]
        );

        if (decision.enterCooldown && config.cooldownBlocks > 0) {
            cooldownUntilBlock[pid] = block.number + config.cooldownBlocks;
        }

        emit FeeDecisionRecorded(
            pid,
            params.zeroForOne,
            params.amountSpecified,
            decision.feeBps,
            decision.reasonFlags,
            decision.regime,
            decision.volatilityScore,
            decision.imbalanceScoreBps
        );

        // OR the override flag so PoolManager applies our per-swap fee instead of the stored fee.
        uint24 overrideFee = decision.feeBps | LPFeeLibrary.OVERRIDE_FEE_FLAG;
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, overrideFee);
    }

    /// @dev Imbalance is approximated as |amount| relative to active liquidity, in bps, capped at 10_000.
    function _estimateImbalance(uint256 absAmount, uint128 liquidity) private pure returns (uint16) {
        if (liquidity == 0) return 0;
        uint256 score = (absAmount * 10_000) / uint256(liquidity);
        if (score > 10_000) score = 10_000;
        return uint16(score);
    }
}
