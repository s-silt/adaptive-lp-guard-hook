// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Create2Deployer
/// @notice Minimal CREATE2 deployer used to mine hook addresses on chains
///         that do not have Foundry's deterministic proxy pre-deployed.
contract Create2Deployer {
    error DeployFailed();

    event Deployed(address indexed deployedTo, bytes32 indexed salt);

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address deployedTo) {
        assembly {
            let p := mload(0x40)
            calldatacopy(p, initCode.offset, initCode.length)
            deployedTo := create2(0, p, initCode.length, salt)
        }
        if (deployedTo == address(0)) revert DeployFailed();
        emit Deployed(deployedTo, salt);
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}
