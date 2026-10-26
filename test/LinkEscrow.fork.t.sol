// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LinkEscrow} from "../contracts/LinkEscrow.sol";

interface IMUSD {
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
    function allowance(address, address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// T-FORK: run with
///   forge test --fork-url https://rpc.test.mezo.org --match-contract Fork
contract LinkEscrowForkTest is Test {
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function test_Fork_MusdPermitSetsAllowance() public {
        if (block.chainid != 31611) {
            vm.skip(true);
        }
        LinkEscrow escrow = new LinkEscrow(MUSD);
        (address owner, uint256 ownerPk) = makeAddrAndKey("forkOwner");
        uint256 value = 50e18;
        uint256 deadline = block.timestamp + 1800;

        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(escrow), value, IMUSD(MUSD).nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IMUSD(MUSD).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        IMUSD(MUSD).permit(owner, address(escrow), value, deadline, v, r, s);
        assertEq(IMUSD(MUSD).allowance(owner, address(escrow)), value);
        assertEq(IMUSD(MUSD).nonces(owner), 1);
    }
}
