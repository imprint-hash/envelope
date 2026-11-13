// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnvelopeV2} from "../contracts/EnvelopeV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPool, MockPoolsRouter, MockFactory} from "./mocks/MockPools.sol";
import {EnvelopeV2Base} from "./EnvelopeV2.t.sol";

/// claimWithOption: claim an envelope into a Mezo Pools position (EARN) or with a little BTC for
/// gas (GAS_TIP), gasless for the recipient, authorised by the link key. Mock router and pools.
contract EnvelopeV2PoolsTest is EnvelopeV2Base {
    event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount);
    event ClaimedWithOption(uint256 indexed id, address indexed recipient, uint8 mode, uint256 musdSent, uint256 out);
    event RelayerPaid(address indexed relayer, uint256 amount);

    MockERC20 token;
    EnvelopeV2 env;
    Pools p;

    address sender = makeAddr("sender");
    address link;
    uint256 linkPk;
    address recipient = makeAddr("recipient");
    address relayer = makeAddr("relayer");
    address treasury = makeAddr("treasury");

    uint8 constant EARN = 1;
    uint8 constant TIP = 2;
    uint256 constant AMOUNT = 100e18;
    uint256 constant FEE = 0.5e18;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockERC20("Mezo USD");
        p = _mockPools(address(token));
        env = new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD, p.cfg);
        (link, linkPk) = makeAddrAndKey("link");
        token.mint(sender, 10_000_000e18);
        vm.prank(sender);
        token.approve(address(env), type(uint256).max);
    }

    function _create(uint256 amount) internal returns (uint256 id) {
        vm.prank(sender);
        id = env.create(link, amount, "");
    }

    function _claimOpt(uint256 id, address to, uint8 mode, uint256 minOut) internal {
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sigOption(env, linkPk, id, to, mode, minOut, dl);
        vm.prank(relayer);
        env.claimWithOption(id, to, mode, minOut, dl, sig);
    }

    function _status(uint256 id) internal view returns (EnvelopeV2.Status st) {
        (,, st,,) = env.deposits(id);
    }

    function _assertNoAllowances() internal view {
        assertEq(token.allowance(address(env), address(p.router)), 0, "MUSD allowance reset");
        assertEq(p.partner.allowance(address(env), address(p.router)), 0, "partner allowance reset");
    }

    /// Plain claimFor still works after a failed option (the envelope stayed Open).
    function _plainClaimStillWorks(uint256 id, uint256 amount) internal {
        assertEq(uint256(_status(id)), uint256(EnvelopeV2.Status.Open), "still open");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, env.claimDigest(id, recipient));
        vm.prank(relayer);
        env.claimFor(id, recipient, abi.encodePacked(r, s, v));
        assertEq(token.balanceOf(recipient), amount);
    }

    // ================================================================ config

    function test_Constructor_StoresPools() public view {
        assertEq(env.router(), address(p.router));
        assertEq(env.factory(), p.cfg.factory);
        assertEq(env.partner(), address(p.partner));
        assertEq(env.btc(), address(p.btc));
        assertEq(env.earnPool(), address(p.earnPool));
        assertEq(env.btcPool(), address(p.btcPool));
    }

    function test_Constructor_NoPoolsMeansOptionsOff() public {
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD, _noPools());
        assertEq(e.router(), address(0));
        vm.expectRevert(EnvelopeV2.PoolsDisabled.selector);
        e.claimWithOption(1, recipient, EARN, 0, block.timestamp, "");
    }

    function test_RevertWhen_Constructor_PartialPools() public {
        EnvelopeV2.PoolsConfig memory c = p.cfg;
        c.btcPool = address(0);
        vm.expectRevert(EnvelopeV2.BadPoolsConfig.selector);
        new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD, c);
    }

    function test_RevertWhen_Constructor_PoolNotWhatRouterSays() public {
        EnvelopeV2.PoolsConfig memory c = p.cfg;
        (c.earnPool, c.btcPool) = (c.btcPool, c.earnPool);
        vm.expectRevert(EnvelopeV2.BadPoolsConfig.selector);
        new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD, c);
    }

    function test_RevertWhen_Constructor_PoolsAddressNotAContract() public {
        EnvelopeV2.PoolsConfig memory c = p.cfg;
        c.factory = makeAddr("eoa-factory");
        vm.expectRevert(EnvelopeV2.BadPoolsConfig.selector);
        new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD, c);
    }

    function test_RevertWhen_Constructor_PartnerIsMusd() public {
        EnvelopeV2.PoolsConfig memory c = p.cfg;
        c.partner = address(token);
        vm.expectRevert(EnvelopeV2.BadPoolsConfig.selector);
        new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD, c);
    }

    function test_GasTipFor() public view {
        assertEq(env.gasTipFor(100e18), 1e18); // capped at 1 MUSD
        assertEq(env.gasTipFor(20e18), 1e18); // exactly 5% = 1
        assertEq(env.gasTipFor(10e18), 0.5e18); // 5%
        assertEq(env.gasTipFor(19), 0);
    }

    // ================================================================ EARN

    function test_Earn_RecipientGetsLpAndDust() public {
        uint256 other = _create(7e18); // someone else's envelope must be untouched
        uint256 id = _create(AMOUNT);
        // swap 30 MUSD -> 24 partner; pool wants 0.4 partner per MUSD: 60 MUSD + 24 partner -> 84 LP;
        // 10 MUSD unused goes back to the recipient as MUSD.
        vm.expectEmit(true, true, true, true, address(env));
        emit Claimed(id, recipient, relayer, AMOUNT);
        vm.expectEmit(true, true, false, true, address(env));
        emit ClaimedWithOption(id, recipient, EARN, 10e18, 84e18);
        vm.expectEmit(true, false, false, true, address(env));
        emit RelayerPaid(relayer, REWARD);
        _claimOpt(id, recipient, EARN, 84e18);

        assertEq(p.earnPool.balanceOf(recipient), 84e18, "LP position owned by the recipient");
        assertEq(token.balanceOf(recipient), 10e18, "dust MUSD refunded");
        assertEq(p.partner.balanceOf(recipient), 0);
        assertEq(uint256(_status(id)), uint256(EnvelopeV2.Status.Claimed));
        assertEq(token.balanceOf(relayer), REWARD);
        assertEq(env.gasFund(), env.feeFor(7e18) + FEE - REWARD);
        assertEq(token.balanceOf(address(env)), 7e18 + env.gasFund(), "only the other envelope + fund left");
        assertEq(p.partner.balanceOf(address(env)), 0);
        _assertNoAllowances();
        other; // silence
    }

    function test_Earn_PartnerDustGoesToRecipient() public {
        // Pool wants lots of partner: 70 MUSD would need 70 partner, we have 24 -> 24 MUSD + 24 partner.
        p.router.setLpRatio(address(token), address(p.partner), 1, 1);
        uint256 id = _create(AMOUNT);
        _claimOpt(id, recipient, EARN, 1);
        assertEq(p.earnPool.balanceOf(recipient), 48e18);
        assertEq(token.balanceOf(recipient), 46e18, "unused MUSD back");
        // and when the pool wants little partner, partner dust is refunded
        p.router.setLpRatio(address(token), address(p.partner), 1, 10);
        uint256 id2 = _create(AMOUNT);
        address r2 = makeAddr("r2");
        _claimOpt(id2, r2, EARN, 1);
        // 70 MUSD needs 7 partner; 17 partner refunded
        assertEq(p.earnPool.balanceOf(r2), 77e18);
        assertEq(p.partner.balanceOf(r2), 17e18, "unused partner back");
        assertEq(p.partner.balanceOf(address(env)), 0);
        _assertNoAllowances();
    }

    function test_RevertWhen_Earn_SlippageThenPlainClaimWorks() public {
        uint256 id = _create(AMOUNT);
        p.router.setLpHaircut(100); // pool moved: 1% fewer LP than quoted
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 84e18, dl);
        vm.expectRevert(EnvelopeV2.InsufficientOutput.selector);
        env.claimWithOption(id, recipient, EARN, 84e18, dl, sig);
        assertEq(token.balanceOf(address(env)), AMOUNT + FEE, "nothing left the contract");
        _assertNoAllowances();
        _plainClaimStillWorks(id, AMOUNT);
    }

    function test_RevertWhen_Earn_RatioZero() public {
        p.router.setRatio(0);
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.AmountTooSmall.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    function test_RevertWhen_Earn_RatioWholeAmount() public {
        p.router.setRatio(1e18);
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.AmountTooSmall.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    // ================================================================ GAS_TIP

    function test_GasTip_RecipientGetsBtcAndRest() public {
        uint256 id = _create(AMOUNT);
        uint256 btcOut = uint256(1e18) / 80_000;
        vm.expectEmit(true, true, false, true, address(env));
        emit ClaimedWithOption(id, recipient, TIP, AMOUNT - 1e18, btcOut);
        _claimOpt(id, recipient, TIP, btcOut);
        assertEq(p.btc.balanceOf(recipient), btcOut, "BTC for gas");
        assertEq(token.balanceOf(recipient), AMOUNT - 1e18, "the rest as MUSD");
        assertEq(token.balanceOf(relayer), REWARD);
        assertEq(token.balanceOf(address(env)), env.gasFund());
        _assertNoAllowances();
    }

    function test_GasTip_SmallEnvelopeUsesFivePercent() public {
        uint256 id = _create(10e18);
        _claimOpt(id, recipient, TIP, 1);
        assertEq(token.balanceOf(recipient), 9.5e18);
        assertEq(p.btc.balanceOf(recipient), uint256(0.5e18) / 80_000);
    }

    function test_RevertWhen_GasTip_SlippageThenPlainClaimWorks() public {
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        uint256 tooMuch = uint256(1e18) / 80_000 + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, TIP, tooMuch, dl);
        vm.expectRevert(bytes("InsufficientOutputAmount")); // router enforces minOut
        env.claimWithOption(id, recipient, TIP, tooMuch, dl, sig);
        _assertNoAllowances();
        _plainClaimStillWorks(id, AMOUNT);
    }

    function test_RevertWhen_GasTip_TooSmall() public {
        uint256 id = _create(19);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, TIP, 0, dl);
        vm.expectRevert(EnvelopeV2.AmountTooSmall.selector);
        env.claimWithOption(id, recipient, TIP, 0, dl, sig);
    }

    function test_RevertWhen_GasTip_ZeroBtcOut() public {
        uint256 id = _create(1e6); // tip 5e4 -> 0 BTC at 1/80_000
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, TIP, 0, dl);
        vm.expectRevert(EnvelopeV2.InsufficientOutput.selector);
        env.claimWithOption(id, recipient, TIP, 0, dl, sig);
    }

    // ================================================================ signatures, modes, replay

    function test_RevertWhen_Option_WrongSigner() public {
        uint256 id = _create(AMOUNT);
        (, uint256 badPk) = makeAddrAndKey("not-the-link");
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, badPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    function test_RevertWhen_Option_RelayerChangesAnything() public {
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 80e18, dl);
        vm.startPrank(relayer);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, relayer, EARN, 80e18, dl, sig); // recipient
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, recipient, TIP, 80e18, dl, sig); // mode
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, recipient, EARN, 0, dl, sig); // minOut (relayer wants room to sandwich)
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, recipient, EARN, 80e18, dl + 1, sig); // deadline
        vm.stopPrank();
    }

    function test_RevertWhen_Option_PlainClaimSigNotAccepted() public {
        uint256 id = _create(AMOUNT);
        bytes memory claimSig = _sigClaim(env, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, recipient, EARN, 0, block.timestamp, claimSig);
    }

    function test_RevertWhen_Option_Replayed() public {
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, TIP, 1, dl);
        env.claimWithOption(id, recipient, TIP, 1, dl, sig);
        vm.expectRevert(EnvelopeV2.AlreadyClaimed.selector);
        env.claimWithOption(id, recipient, TIP, 1, dl, sig);
        // and a plain claim after an option claim
        bytes memory cs = _sigClaim(env, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.AlreadyClaimed.selector);
        env.claimFor(id, recipient, cs);
    }

    function test_RevertWhen_Option_AfterPlainClaim() public {
        uint256 id = _create(AMOUNT);
        bytes memory cs = _sigClaim(env, linkPk, id, recipient);
        env.claimFor(id, recipient, cs);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.AlreadyClaimed.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    function test_RevertWhen_Option_ModeOutOfRange() public {
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        uint8[3] memory bad = [uint8(0), 3, 255];
        for (uint256 i; i < bad.length; i++) {
            bytes memory sig = _sigOption(env, linkPk, id, recipient, bad[i], 0, dl);
            vm.expectRevert(EnvelopeV2.BadMode.selector);
            env.claimWithOption(id, recipient, bad[i], 0, dl, sig);
        }
    }

    function test_RevertWhen_Option_DeadlinePassed() public {
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.warp(dl + 1);
        vm.expectRevert(EnvelopeV2.SignatureExpired.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    function test_RevertWhen_Option_EnvelopeExpired() public {
        uint256 id = _create(AMOUNT);
        vm.warp(block.timestamp + 7 days);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.Expired.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    function test_RevertWhen_Option_NotFound() public {
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, 99, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.NotFound.selector);
        env.claimWithOption(99, recipient, EARN, 1, dl, sig);
    }

    function test_RevertWhen_Option_RecipientIsPoolsContract() public {
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        address[7] memory bad = [
            address(0),
            address(env),
            address(token),
            address(p.router),
            address(p.partner),
            address(p.earnPool),
            address(p.btcPool)
        ];
        for (uint256 i; i < bad.length; i++) {
            bytes memory sig = _sigOption(env, linkPk, id, bad[i], EARN, 1, dl);
            vm.expectRevert(EnvelopeV2.ZeroRecipient.selector);
            env.claimWithOption(id, bad[i], EARN, 1, dl, sig);
        }
    }

    function test_RevertWhen_Option_PoolsDown_MoneyStaysInEnvelope() public {
        uint256 id = _create(AMOUNT);
        p.router.setBroken(true);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(bytes("BROKEN"));
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
        _plainClaimStillWorks(id, AMOUNT);
    }

    // ================================================================ approvals, reentrancy

    function test_Option_RouterTakesLess_AllowanceStillReset() public {
        p.router.setTakeLess(1e15); // router pulls a bit less than approved
        uint256 id = _create(AMOUNT);
        _claimOpt(id, recipient, TIP, 1);
        _assertNoAllowances();
        // the MUSD the router left behind is this envelope's and goes to the recipient
        assertEq(token.balanceOf(recipient), AMOUNT - 1e18 + 1e15);
        assertEq(token.balanceOf(address(env)), env.gasFund());

        uint256 id2 = _create(AMOUNT);
        address r2 = makeAddr("r2");
        _claimOpt(id2, r2, EARN, 1);
        _assertNoAllowances();
        assertEq(token.balanceOf(address(env)), env.gasFund());
    }

    function test_Reentrancy_RouterCallsBackIntoClaim() public {
        uint256 id1 = _create(AMOUNT);
        uint256 id2 = _create(AMOUNT);
        address mallory = makeAddr("mallory");
        p.router
            .arm(
                address(env), abi.encodeCall(EnvelopeV2.claimFor, (id2, mallory, _sigClaim(env, linkPk, id2, mallory)))
            );
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id1, recipient, TIP, 1, dl);
        vm.expectRevert(EnvelopeV2.Reentrancy.selector);
        env.claimWithOption(id1, recipient, TIP, 1, dl, sig);
        assertEq(token.balanceOf(mallory), 0);
        assertEq(token.balanceOf(address(env)), 2 * (AMOUNT + FEE));
    }

    function test_Reentrancy_RouterCallsBackIntoSweep() public {
        uint256 id = _create(AMOUNT);
        p.router.arm(address(env), abi.encodeCall(EnvelopeV2.sweepSurplus, ()));
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, linkPk, id, recipient, EARN, 1, dl);
        vm.expectRevert(EnvelopeV2.Reentrancy.selector);
        env.claimWithOption(id, recipient, EARN, 1, dl, sig);
    }

    // ================================================================ rewards

    function test_Option_RelayerRewardSameAsPlainClaim() public {
        uint256 id = _create(1e18); // fee 0.005 -> reward capped at fee/2
        _claimOpt(id, recipient, TIP, 1);
        assertEq(token.balanceOf(relayer), 0.0025e18);
        assertEq(env.gasFund(), 0.0025e18);
    }

    // ================================================================ fuzz

    function testFuzz_GasTip_ExactSplit(uint96 amount) public {
        amount = uint96(bound(amount, 1e12 * 20, 1_000_000e18));
        uint256 id = _create(amount);
        uint256 tip = env.gasTipFor(amount);
        if (tip / 80_000 == 0) return;
        _claimOpt(id, recipient, TIP, 1);
        assertEq(token.balanceOf(recipient), amount - tip);
        assertEq(p.btc.balanceOf(recipient), tip / 80_000);
        assertLe(tip, 1e18);
        assertEq(token.balanceOf(address(env)), env.gasFund());
    }

    function testFuzz_Earn_EnvelopeFullyAccounted(uint96 amount, uint256 ratio, uint256 num, uint256 den) public {
        amount = uint96(bound(amount, 1e9, 1_000_000e18));
        ratio = bound(ratio, 0.05e18, 0.95e18);
        num = bound(num, 1, 100);
        den = bound(den, 1, 100);
        p.router.setRatio(ratio);
        p.router.setLpRatio(address(token), address(p.partner), num, den);
        uint256 id = _create(amount);
        uint256 swapIn = uint256(amount) * ratio / 1e18;
        uint256 got = swapIn * 8 / 10;
        if (got == 0) return;
        _claimOpt(id, recipient, EARN, 1);
        // every MUSD of the envelope is either in the pool or back with the recipient
        uint256 musdInPool = token.balanceOf(address(p.earnPool));
        assertEq(musdInPool + token.balanceOf(recipient) + swapIn, amount);
        assertEq(p.partner.balanceOf(address(p.earnPool)) + p.partner.balanceOf(recipient), got);
        assertGt(p.earnPool.balanceOf(recipient), 0);
        assertEq(token.balanceOf(address(env)), env.gasFund());
        _assertNoAllowances();
    }

    function testFuzz_Option_OnlyLinkKey(uint256 pk, uint8 mode) public {
        pk = bound(pk, 1, N - 1);
        vm.assume(pk != linkPk);
        mode = uint8(bound(mode, 1, 2));
        uint256 id = _create(AMOUNT);
        uint256 dl = block.timestamp + 1;
        bytes memory sig = _sigOption(env, pk, id, recipient, mode, 1, dl);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimWithOption(id, recipient, mode, 1, dl, sig);
    }
}
