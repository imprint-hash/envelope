// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EnvelopeV2, IPoolsRouter} from "../contracts/EnvelopeV2.sol";

interface IERC20View {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IPoolsRouterView {
    function getAmountsOut(uint256 amountIn, IPoolsRouter.Route[] calldata routes)
        external
        view
        returns (uint256[] memory);
    function getReserves(address tokenA, address tokenB, bool stable, address factory)
        external
        view
        returns (uint256 reserveA, uint256 reserveB);
    function quoteStableLiquidityRatio(address tokenA, address tokenB, address factory) external view returns (uint256);
}

/// Mezo's BTC ERC-20 (0x7b7c…0000) is a chain precompile whose balance IS the native BTC balance.
/// Forge's EVM can't run Mezo precompiles, so on the fork we put this stand-in at that address:
/// balanceOf(a) == a.balance, and transfers move native BTC, exactly like on Mezo. The pool's BTC
/// reserves are the pool's real native balance from the fork.
contract BtcPrecompileStandIn {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function balanceOf(address a) external view returns (uint256) {
        return a.balance;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) internal {
        require(f.balance >= v, "BTC balance");
        vm.deal(f, f.balance - v);
        vm.deal(to, to.balance + v);
    }
}

/// Claim options against the REAL Mezo Pools router and pools on a Mezo testnet fork.
///
///   forge test --fork-url https://rpc.test.mezo.org --match-path test/EnvelopeV2Pools.fork.t.sol -vv
contract EnvelopeV2PoolsForkTest is Test {
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant ROUTER = 0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9;
    address constant FACTORY = 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A;
    address constant MUSDC = 0xe1a26db653708A2AD8F824E92Db9852410e33A59;
    address constant BTC = 0x7b7C000000000000000000000000000000000000;
    address constant POOL_MUSD_MUSDC = 0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e;
    address constant POOL_MUSD_BTC = 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9;

    uint256 constant SEND = 50e18;
    uint256 constant REWARD = 0.05e18;
    uint8 constant EARN = 1; // env.MODE_EARN()
    uint8 constant GAS_TIP = 2; // env.MODE_GAS_TIP()

    EnvelopeV2 env;
    address sender = makeAddr("pools-sender");
    address relayer = makeAddr("pools-relayer");
    address recipient = makeAddr("pools-recipient");
    address link;
    uint256 linkPk;

    function setUp() public {
        if (block.chainid != 31611) {
            vm.skip(true);
            return;
        }
        env = new EnvelopeV2(
            MUSD,
            makeAddr("pools-treasury"),
            50,
            REWARD,
            EnvelopeV2.PoolsConfig({
                router: ROUTER,
                factory: FACTORY,
                partner: MUSDC,
                btc: BTC,
                earnPool: POOL_MUSD_MUSDC,
                btcPool: POOL_MUSD_BTC
            })
        );
        assertEq(env.MODE_EARN(), EARN);
        assertEq(env.MODE_GAS_TIP(), GAS_TIP);
        (link, linkPk) = makeAddrAndKey("pools-link");
        deal(MUSD, sender, 1_000e18); // test MUSD for the sender (the borrow path is covered by EnvelopeV2.fork.t.sol)
        vm.prank(sender);
        IERC20View(MUSD).approve(address(env), type(uint256).max);
    }

    function _create() internal returns (uint256 id) {
        vm.prank(sender);
        id = env.create(link, SEND, "Keep it growing");
    }

    function _sign(uint256 id, uint8 mode, uint256 minOut, uint256 dl) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, env.claimWithOptionDigest(id, recipient, mode, minOut, dl));
        return abi.encodePacked(r, s, v);
    }

    function _route(address to, bool stable) internal pure returns (IPoolsRouter.Route[] memory r) {
        r = new IPoolsRouter.Route[](1);
        r[0] = IPoolsRouter.Route({from: MUSD, to: to, stable: stable, factory: FACTORY});
    }

    /// The same quote the claim page shows: router ratio + getAmountsOut, then the LP the pool
    /// would mint after our own swap has moved its reserves (Velodrome mint maths).
    function _quoteEarnLp(uint256 amount) internal view returns (uint256 lp) {
        uint256 swapIn = amount * IPoolsRouterView(ROUTER).quoteStableLiquidityRatio(MUSD, MUSDC, FACTORY) / 1e18;
        uint256 got = IPoolsRouterView(ROUTER).getAmountsOut(swapIn, _route(MUSDC, true))[1];
        (uint256 rA, uint256 rB) = IPoolsRouterView(ROUTER).getReserves(MUSD, MUSDC, true, FACTORY);
        rA += swapIn;
        rB -= got;
        uint256 keep = amount - swapIn;
        uint256 a = keep;
        uint256 b = keep * rB / rA;
        if (b > got) (a, b) = (got * rA / rB, got);
        uint256 supply = IERC20View(POOL_MUSD_MUSDC).totalSupply();
        uint256 la = a * supply / rA;
        uint256 lb = b * supply / rB;
        lp = la < lb ? la : lb;
    }

    function test_Fork_Earn_RecipientGetsRealMezoPoolsLp() public {
        uint256 id = _create();
        uint256 quoted = _quoteEarnLp(SEND);
        uint256 minLp = quoted * 99 / 100; // 1% slippage, like the claim page
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sign(id, EARN, minLp, dl);
        uint256 poolMusd0 = IERC20View(MUSD).balanceOf(POOL_MUSD_MUSDC);

        vm.prank(relayer);
        env.claimWithOption(id, recipient, EARN, minLp, dl, sig);

        uint256 lp = IERC20View(POOL_MUSD_MUSDC).balanceOf(recipient);
        console2.log("quoted LP", quoted);
        console2.log("LP tokens to recipient", lp);
        console2.log("MUSD dust back", IERC20View(MUSD).balanceOf(recipient));
        console2.log("mUSDC dust back", IERC20View(MUSDC).balanceOf(recipient));
        assertGe(lp, minLp, "real MUSD/mUSDC LP tokens, at least the signed minimum");
        assertApproxEqRel(lp, quoted, 0.001e18, "page quote within 0.1%");
        assertGt(IERC20View(MUSD).balanceOf(POOL_MUSD_MUSDC), poolMusd0, "MUSD went into the pool");
        assertLt(IERC20View(MUSD).balanceOf(recipient), 0.01e18, "almost nothing unused");
        assertEq(IERC20View(MUSD).balanceOf(relayer), REWARD, "relayer reward as usual");
        assertEq(IERC20View(MUSD).balanceOf(address(env)), env.gasFund(), "only the gas fund is left");
        assertEq(IERC20View(MUSDC).balanceOf(address(env)), 0);
        assertEq(recipient.balance, 0, "recipient spent no gas");
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        assertEq(uint256(d.status), uint256(EnvelopeV2.Status.Claimed));
    }

    function test_Fork_GasTip_RecipientGetsBtcAndMusd() public {
        vm.etch(BTC, address(new BtcPrecompileStandIn()).code);
        vm.allowCheatcodes(BTC);
        uint256 id = _create();
        uint256 tip = env.gasTipFor(SEND);
        uint256 quoted = IPoolsRouterView(ROUTER).getAmountsOut(tip, _route(BTC, false))[1];
        uint256 minBtc = quoted * 99 / 100;
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sign(id, GAS_TIP, minBtc, dl);

        vm.prank(relayer);
        env.claimWithOption(id, recipient, GAS_TIP, minBtc, dl, sig);
        assertEq(IERC20View(MUSD).balanceOf(relayer), REWARD, "relayer reward as usual");

        console2.log("BTC for gas (wei)", recipient.balance);
        assertEq(tip, 1e18, "1 MUSD becomes BTC");
        assertEq(recipient.balance, quoted, "native BTC on Mezo = the BTC token balance");
        assertGe(recipient.balance, minBtc);
        assertEq(IERC20View(MUSD).balanceOf(recipient), SEND - tip, "the rest arrives as MUSD");
        assertEq(IERC20View(MUSD).balanceOf(address(env)), env.gasFund());
    }

    function test_Fork_Earn_SlippageRevertsAndPlainClaimStillWorks() public {
        uint256 id = _create();
        uint256 greedy = _quoteEarnLp(SEND) * 102 / 100; // more than the pool can give
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sign(id, EARN, greedy, dl);
        vm.prank(relayer);
        vm.expectRevert(EnvelopeV2.InsufficientOutput.selector);
        env.claimWithOption(id, recipient, EARN, greedy, dl, sig);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, env.claimDigest(id, recipient));
        vm.prank(relayer);
        env.claimFor(id, recipient, abi.encodePacked(r, s, v));
        assertEq(IERC20View(MUSD).balanceOf(recipient), SEND, "full envelope as plain MUSD");
    }
}
