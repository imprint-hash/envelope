// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {EnvelopeV2} from "../contracts/EnvelopeV2.sol";

/// Deploys EnvelopeV2 on Mezo testnet. Not run by the builders; the lead deploys.
///
///   TREASURY_ADDRESS=0x... DEPLOYER_PRIVATE_KEY=... \
///   forge script script/DeployV2.s.sol --rpc-url https://rpc.test.mezo.org --broadcast
///
/// The key is read from the environment inside forge only; it is never printed.
contract DeployV2 is Script {
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    uint256 constant FEE_BPS = 50; // 0.5%, paid by the sender on top
    uint256 constant RELAYER_REWARD = 0.05e18; // 0.05 MUSD

    function run() external returns (EnvelopeV2 env) {
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        env = new EnvelopeV2(MUSD, treasury, FEE_BPS, RELAYER_REWARD);
        vm.stopBroadcast();
        console2.log("EnvelopeV2 deployed at", address(env));
        console2.log("treasury", treasury);
    }
}
