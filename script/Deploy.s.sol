// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LinkEscrow} from "../contracts/LinkEscrow.sol";

contract Deploy is Script {
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;

    function run() external returns (LinkEscrow escrow) {
        vm.startBroadcast(vm.envUint("RELAYER_PRIVATE_KEY"));
        escrow = new LinkEscrow(MUSD);
        vm.stopBroadcast();
        console2.log("LinkEscrow deployed at", address(escrow));
    }
}
