const path = require("path");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
} = require("hardhat/builtin-tasks/task-names");

require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const SOLC_VERSION = "0.8.24";
const SOLC_LONG_VERSION = "0.8.24+commit.e11b9ed9";

// The sandbox blocks binaries.soliditylang.org, so the standard Hardhat
// compiler downloader fails. Point Hardhat at the soljson bundled with the
// `solc` npm package instead — it's the same compiler, just shipped via npm.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: SOLC_VERSION,
      longVersion: SOLC_LONG_VERSION,
    };
  }
  return runSuper(args);
});

module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
};
