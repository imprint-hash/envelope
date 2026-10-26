// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @notice Token that calls back into a target (the escrow) during transfer/transferFrom.
///         If the callback fails, the token reverts with the callback's revert data.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public onTransfer;
    bool public onTransferFrom;

    constructor() MockERC20("Reentrant") {}

    function arm(address target_, bytes calldata payload_, bool onTransfer_, bool onTransferFrom_) external {
        target = target_;
        payload = payload_;
        onTransfer = onTransfer_;
        onTransferFrom = onTransferFrom_;
    }

    function _callback() private {
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (onTransfer && target != address(0)) _callback();
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (onTransferFrom && target != address(0)) _callback();
        return super.transferFrom(from, to, amount);
    }
}
