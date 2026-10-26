// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Token whose transfer/transferFrom return false without moving anything.
contract FalseToken {
    mapping(address => uint256) public balanceOf;

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
