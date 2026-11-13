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

    // Mezo Pools on testnet (https://mezo.org/docs/developers/features/mezo-pools), checked on chain 13 Nov.
    // The constructor re-checks both pools against router.poolFor(), so a typo can't deploy.
    address constant POOLS_ROUTER = 0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9;
    address constant POOL_FACTORY = 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A;
    address constant MUSDC = 0xe1a26db653708A2AD8F824E92Db9852410e33A59; // MUSD/mUSDT pool is empty, so mUSDC
    address constant BTC = 0x7b7C000000000000000000000000000000000000;
    address constant POOL_MUSD_MUSDC = 0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e; // stable
    address constant POOL_MUSD_BTC = 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9; // volatile

    function run() external returns (EnvelopeV2 env) {
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        EnvelopeV2.PoolsConfig memory pools = EnvelopeV2.PoolsConfig({
            router: POOLS_ROUTER,
            factory: POOL_FACTORY,
            partner: MUSDC,
            btc: BTC,
            earnPool: POOL_MUSD_MUSDC,
            btcPool: POOL_MUSD_BTC
        });
        env = new EnvelopeV2(MUSD, treasury, FEE_BPS, RELAYER_REWARD, pools);
        vm.stopBroadcast();
        console2.log("EnvelopeV2 deployed at", address(env));
        console2.log("treasury", treasury);
    }
}
