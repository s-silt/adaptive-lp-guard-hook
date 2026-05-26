// SPDX-License-Identifier: MIT
// This file exists so solc reaches and compiles the v4-core PoolManager and
// the test routers we use for deployment / smoke testing. It defines no
// contracts of its own.
pragma solidity ^0.8.24;

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {TestERC20} from "@uniswap/v4-core/src/test/TestERC20.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
