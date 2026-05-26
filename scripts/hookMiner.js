const { ethers } = require("ethers");

const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 13,
  AFTER_INITIALIZE: 1 << 12,
  BEFORE_ADD_LIQUIDITY: 1 << 11,
  AFTER_ADD_LIQUIDITY: 1 << 10,
  BEFORE_REMOVE_LIQUIDITY: 1 << 9,
  AFTER_REMOVE_LIQUIDITY: 1 << 8,
  BEFORE_SWAP: 1 << 7,
  AFTER_SWAP: 1 << 6,
  BEFORE_DONATE: 1 << 5,
  AFTER_DONATE: 1 << 4,
  BEFORE_SWAP_RETURNS_DELTA: 1 << 3,
  AFTER_SWAP_RETURNS_DELTA: 1 << 2,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0
};

const ALL_HOOK_MASK = (1 << 14) - 1;
const MAX_LOOP = 160_444;

// CREATE2 Deployer Proxy used by Foundry — also fine for ethers if you point at it.
// For ad-hoc deploys we let the caller pick `deployer` (typically the EOA wallet address).
const FOUNDRY_CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

function permissionsToFlags(perms) {
  let f = 0;
  if (perms.beforeInitialize) f |= HOOK_FLAGS.BEFORE_INITIALIZE;
  if (perms.afterInitialize) f |= HOOK_FLAGS.AFTER_INITIALIZE;
  if (perms.beforeAddLiquidity) f |= HOOK_FLAGS.BEFORE_ADD_LIQUIDITY;
  if (perms.afterAddLiquidity) f |= HOOK_FLAGS.AFTER_ADD_LIQUIDITY;
  if (perms.beforeRemoveLiquidity) f |= HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY;
  if (perms.afterRemoveLiquidity) f |= HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY;
  if (perms.beforeSwap) f |= HOOK_FLAGS.BEFORE_SWAP;
  if (perms.afterSwap) f |= HOOK_FLAGS.AFTER_SWAP;
  if (perms.beforeDonate) f |= HOOK_FLAGS.BEFORE_DONATE;
  if (perms.afterDonate) f |= HOOK_FLAGS.AFTER_DONATE;
  if (perms.beforeSwapReturnDelta) f |= HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA;
  if (perms.afterSwapReturnDelta) f |= HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA;
  if (perms.afterAddLiquidityReturnDelta) f |= HOOK_FLAGS.AFTER_ADD_LIQUIDITY_RETURNS_DELTA;
  if (perms.afterRemoveLiquidityReturnDelta) f |= HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA;
  return f;
}

/// @notice Find a salt that produces a hook address whose bottom 14 bits == flags.
/// @param deployer The address that will execute CREATE2 (the wallet for ethers Wallet.deploy,
///                 or the deployer proxy if you route through one).
/// @param flags    uint16 mask of HOOK_FLAGS values.
/// @param creationCode 0x-prefixed hex of contract creationCode.
/// @param constructorArgs 0x-prefixed hex of ABI-encoded constructor args.
function findSalt(deployer, flags, creationCode, constructorArgs) {
  const maskedFlags = flags & ALL_HOOK_MASK;
  const codeAndArgs = ethers.concat([creationCode, constructorArgs || "0x"]);
  const initCodeHash = ethers.keccak256(codeAndArgs);

  for (let salt = 0; salt < MAX_LOOP; salt++) {
    const saltHex = ethers.zeroPadValue(ethers.toBeHex(salt), 32);
    const addr = ethers.getCreate2Address(deployer, saltHex, initCodeHash);
    const bottom14 = parseInt(addr.slice(-4), 16) & ALL_HOOK_MASK;
    if (bottom14 === maskedFlags) {
      return { address: addr, salt: saltHex, attempts: salt + 1 };
    }
  }
  throw new Error("HookMiner: could not find salt in " + MAX_LOOP + " attempts");
}

module.exports = {
  HOOK_FLAGS,
  ALL_HOOK_MASK,
  FOUNDRY_CREATE2_DEPLOYER,
  permissionsToFlags,
  findSalt
};
