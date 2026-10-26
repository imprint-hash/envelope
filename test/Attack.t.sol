// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LinkEscrow} from "../contracts/LinkEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/// @notice Token that burns 1% on every transfer (to probe accounting assumptions).
contract FeeToken is MockERC20 {
    constructor() MockERC20("Fee") {}

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        super.transferFrom(from, to, amount);
        balanceOf[to] -= fee;
        totalSupply -= fee;
        return true;
    }
}

/// @notice Tester's adversarial suite. Every test asserts the DEFENDED behaviour;
///         a failing test == a broken defence.
contract AttackTest is Test {
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    MockERC20 token;
    LinkEscrow escrow;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");
    address link;
    uint256 linkPk;
    uint256 constant AMT = 10e18;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockERC20("Mezo USD");
        escrow = new LinkEscrow(address(token));
        (link, linkPk) = makeAddrAndKey("attack-link");
        token.mint(alice, 1_000e18);
        token.mint(mallory, 1_000e18);
        vm.prank(alice);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(mallory);
        token.approve(address(escrow), type(uint256).max);
    }

    function _sig(LinkEscrow e, uint256 pk, uint256 id, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.claimDigest(id, to));
        return abi.encodePacked(r, s, v);
    }

    function _mk(address who, address l, uint256 amt) internal returns (uint256 id) {
        vm.prank(who);
        id = escrow.create(l, amt, "");
    }

    function _exp(uint256 id) internal view returns (uint64 e) {
        (, e,,,) = escrow.deposits(id);
    }

    // ---------------------------------------------------------------- signature

    /// Relayer / mempool watcher swaps the recipient.
    function test_atk_relayerRedirect() public {
        uint256 id = _mk(alice, link, AMT);
        bytes memory sig = _sig(escrow, linkPk, id, bob);
        vm.prank(mallory);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, mallory, sig);
    }

    /// Same link key reused for two deposits: sig for #1 must not unlock #2.
    function test_atk_sameLinkTwoDeposits_noCrossReplay() public {
        uint256 id1 = _mk(alice, link, AMT);
        uint256 id2 = _mk(alice, link, AMT * 2);
        bytes memory sig1 = _sig(escrow, linkPk, id1, bob);
        escrow.claimFor(id1, bob, sig1);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id2, bob, sig1);
        vm.expectRevert(LinkEscrow.AlreadyClaimed.selector);
        escrow.claimFor(id1, bob, sig1);
    }

    /// Mallory front-runs creation with the SAME link address (she watched the mempool).
    /// Must not hijack Alice's deposit or steal anything.
    function test_atk_squatLinkAddress() public {
        uint256 idM = _mk(mallory, link, 1);
        uint256 idA = _mk(alice, link, AMT);
        assertTrue(idM != idA);
        escrow.claimFor(idA, bob, _sig(escrow, linkPk, idA, bob));
        assertEq(token.balanceOf(bob), AMT);
    }

    /// Two escrows on same chain: cross-contract replay.
    function test_atk_crossContractReplay() public {
        LinkEscrow e2 = new LinkEscrow(address(token));
        vm.prank(alice);
        token.approve(address(e2), type(uint256).max);
        uint256 id = _mk(alice, link, AMT);
        vm.prank(alice);
        uint256 id2 = e2.create(link, AMT, "");
        assertEq(id, id2);
        bytes memory sig = _sig(escrow, linkPk, id, bob);
        escrow.claimFor(id, bob, sig);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        e2.claimFor(id2, bob, sig);
    }

    /// Fork replay: chainId changes after sig made.
    function test_atk_crossChainReplay() public {
        uint256 id = _mk(alice, link, AMT);
        bytes memory sig = _sig(escrow, linkPk, id, bob);
        vm.chainId(999);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, bob, sig);
    }

    /// High-s malleated twin, v in {0,1}, v garbage, 64-byte and 66-byte sigs.
    function test_atk_sigMalleabilityAndShapes() public {
        uint256 id = _mk(alice, link, AMT);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, escrow.claimDigest(id, bob));
        bytes memory hi = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, bob, hi);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, bob, abi.encodePacked(r, s, uint8(29)));
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, bob, abi.encodePacked(r, s));
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, bob, abi.encodePacked(r, s, v, uint8(0)));
        // v as 0/1 is accepted (normalised), single claim only
        escrow.claimFor(id, bob, abi.encodePacked(r, s, v - 27));
        assertEq(token.balanceOf(bob), AMT);
    }

    /// Zero-sig / r=0 must not recover to some address that happens to be `link`.
    function test_atk_zeroSig() public {
        uint256 id = _mk(alice, link, AMT);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, bob, new bytes(65));
    }

    /// Sender's own key (not the link key) cannot claim.
    function test_atk_senderKeyCannotClaim() public {
        (address s2, uint256 s2pk) = makeAddrAndKey("s2");
        token.mint(s2, AMT);
        vm.startPrank(s2);
        token.approve(address(escrow), AMT);
        uint256 id = escrow.create(link, AMT, "");
        vm.stopPrank();
        bytes memory bad = _sig(escrow, s2pk, id, s2);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, s2, bad);
    }

    // ---------------------------------------------------------------- id / status

    function test_atk_idZeroAndUnknown() public {
        bytes memory sig = _sig(escrow, linkPk, 0, bob);
        vm.expectRevert(LinkEscrow.NotFound.selector);
        escrow.claimFor(0, bob, sig);
        vm.expectRevert(LinkEscrow.NotFound.selector);
        escrow.refund(0);
        vm.expectRevert(LinkEscrow.NotFound.selector);
        escrow.refund(type(uint256).max);
    }

    // ---------------------------------------------------------------- expiry edges

    function test_atk_claimAtExactlyExpiresAt() public {
        uint256 id = _mk(alice, link, AMT);
        vm.warp(_exp(id));
        bytes memory sig = _sig(escrow, linkPk, id, bob);
        vm.expectRevert(LinkEscrow.Expired.selector);
        escrow.claimFor(id, bob, sig);
        escrow.refund(id); // refund allowed at the same second: no overlap, no gap
        assertEq(token.balanceOf(alice), 1_000e18);
    }

    function test_atk_refundAtExpiresAtMinus1() public {
        uint256 id = _mk(alice, link, AMT);
        vm.warp(_exp(id) - 1);
        vm.expectRevert(LinkEscrow.NotExpired.selector);
        escrow.refund(id);
        escrow.claimFor(id, bob, _sig(escrow, linkPk, id, bob));
        vm.warp(_exp(id) + 1);
        vm.expectRevert(LinkEscrow.AlreadyClaimed.selector);
        escrow.refund(id);
    }

    /// Anyone can trigger refund, but money only ever goes to the original sender.
    function test_atk_thirdPartyRefundGoesToSender() public {
        uint256 id = _mk(alice, link, AMT);
        vm.warp(_exp(id));
        vm.prank(mallory);
        escrow.refund(id);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(token.balanceOf(mallory), 1_000e18);
    }

    function testFuzz_atk_noWindowOverlap(uint64 dt) public {
        uint256 id = _mk(alice, link, AMT);
        dt = uint64(bound(dt, 0, 30 days));
        vm.warp(block.timestamp + dt);
        bool canClaim = block.timestamp < _exp(id);
        bytes memory sig = _sig(escrow, linkPk, id, bob);
        if (canClaim) {
            vm.expectRevert(LinkEscrow.NotExpired.selector);
            escrow.refund(id);
            escrow.claimFor(id, bob, sig);
        } else {
            vm.expectRevert(LinkEscrow.Expired.selector);
            escrow.claimFor(id, bob, sig);
            escrow.refund(id);
        }
    }

    // ---------------------------------------------------------------- truncation

    function test_atk_uint96Boundary() public {
        uint256 big = uint256(type(uint96).max);
        token.mint(alice, big + 1);
        vm.prank(alice);
        vm.expectRevert(LinkEscrow.AmountTooLarge.selector);
        escrow.create(link, big + 1, "");
        uint256 id = _mk(alice, link, big);
        (,,,, uint96 a) = escrow.deposits(id);
        assertEq(uint256(a), big);
    }

    // ---------------------------------------------------------------- notes

    function test_atk_noteLimits() public {
        bytes memory n141 = new bytes(141);
        vm.prank(alice);
        vm.expectRevert(LinkEscrow.NoteTooLong.selector);
        escrow.create(link, AMT, string(n141));
        // 140 bytes of multibyte UTF-8 still capped by bytes
        vm.prank(alice);
        escrow.create(link, AMT, string(new bytes(140)));
    }

    // ---------------------------------------------------------------- reentrancy

    function test_atk_reenterClaimDuringClaim() public {
        ReentrantToken rt = new ReentrantToken();
        LinkEscrow e = new LinkEscrow(address(rt));
        rt.mint(alice, 100e18);
        vm.prank(alice);
        rt.approve(address(e), type(uint256).max);
        vm.prank(alice);
        uint256 id1 = e.create(link, AMT, "");
        vm.prank(alice);
        uint256 id2 = e.create(link, AMT, "");
        bytes memory sig2 = _sig(e, linkPk, id2, mallory);
        rt.arm(address(e), abi.encodeCall(LinkEscrow.claimFor, (id2, mallory, sig2)), true, false);
        bytes memory sig1 = _sig(e, linkPk, id1, bob);
        // Inner call reverts Reentrancy() (confirmed with -vvvv trace); escrow wraps the
        // failed token call as TransferFailed. Assert nothing moved.
        vm.expectRevert(LinkEscrow.TransferFailed.selector);
        e.claimFor(id1, bob, sig1);
        assertEq(rt.balanceOf(mallory), 0);
        assertEq(rt.balanceOf(address(e)), 2 * AMT);
    }

    function test_atk_reenterRefundDuringCreate() public {
        ReentrantToken rt = new ReentrantToken();
        LinkEscrow e = new LinkEscrow(address(rt));
        rt.mint(alice, 100e18);
        vm.prank(alice);
        rt.approve(address(e), type(uint256).max);
        rt.arm(address(e), abi.encodeCall(LinkEscrow.refund, (1)), false, true);
        vm.prank(alice);
        vm.expectRevert(LinkEscrow.TransferFailed.selector);
        e.create(link, AMT, "");
        assertEq(e.nextId(), 1);
    }

    // ---------------------------------------------------------------- permit

    function _permitSig(uint256 pk, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(token.PERMIT_TYPEHASH(), owner, address(escrow), value, token.nonces(owner), deadline))
            )
        );
        (v, r, s) = vm.sign(pk, digest);
    }

    /// Mallory sees Carol's createWithPermit and submits the permit first. Carol must still succeed.
    function test_atk_permitFrontRunDoesNotGrief() public {
        (address carol, uint256 cpk) = makeAddrAndKey("carol");
        token.mint(carol, AMT);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(cpk, carol, AMT, dl);
        vm.prank(mallory);
        token.permit(carol, address(escrow), AMT, dl, v, r, s);
        vm.prank(carol);
        uint256 id = escrow.createWithPermit(link, AMT, "", dl, v, r, s);
        (address snd,,,,) = escrow.deposits(id);
        assertEq(snd, carol);
    }

    /// Mallory replays Carol's permit sig through createWithPermit as herself: permit is
    /// for owner=msg.sender so it fails silently and Mallory pays from her own balance.
    function test_atk_permitSigStolenByOther() public {
        (address carol, uint256 cpk) = makeAddrAndKey("carol");
        token.mint(carol, AMT);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(cpk, carol, AMT, dl);
        uint256 mBefore = token.balanceOf(mallory);
        vm.prank(mallory);
        escrow.createWithPermit(link, AMT, "", dl, v, r, s);
        assertEq(token.balanceOf(carol), AMT, "carol untouched");
        assertEq(token.balanceOf(mallory), mBefore - AMT);
    }

    /// Bad permit + no allowance must revert, not create an unfunded deposit.
    function test_atk_badPermitNoAllowanceReverts() public {
        (address carol,) = makeAddrAndKey("carol");
        token.mint(carol, AMT);
        vm.prank(carol);
        vm.expectRevert();
        escrow.createWithPermit(link, AMT, "", block.timestamp + 1, 27, bytes32(0), bytes32(0));
        assertEq(escrow.nextId(), 1);
    }

    // ---------------------------------------------------------------- solvency

    /// Escrow must always hold >= sum of open deposits (standard token).
    function testFuzz_atk_solvency(uint96 a1, uint96 a2, uint64 dt) public {
        a1 = uint96(bound(a1, 1, 400e18));
        a2 = uint96(bound(a2, 1, 400e18));
        uint256 id1 = _mk(alice, link, a1);
        uint256 id2 = _mk(mallory, link, a2);
        escrow.claimFor(id1, bob, _sig(escrow, linkPk, id1, bob));
        vm.warp(block.timestamp + bound(dt, 7 days, 30 days));
        escrow.refund(id2);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(bob), a1);
    }

    /// FINDING (informational for MUSD): fee-on-transfer token makes escrow insolvent;
    /// last claimer is stuck. Documents that the contract assumes a plain ERC20.
    function test_atk_feeOnTransfer_lastClaimStuck() public {
        FeeToken ft = new FeeToken();
        LinkEscrow e = new LinkEscrow(address(ft));
        ft.mint(alice, 100e18);
        vm.prank(alice);
        ft.approve(address(e), type(uint256).max);
        vm.prank(alice);
        uint256 id1 = e.create(link, AMT, "");
        vm.prank(alice);
        uint256 id2 = e.create(link, AMT, "");
        e.claimFor(id1, bob, _sig(e, linkPk, id1, bob));
        bytes memory sig2 = _sig(e, linkPk, id2, bob);
        vm.expectRevert(); // underflow: escrow short by 2% of AMT
        e.claimFor(id2, bob, sig2);
    }

    /// FINDING (low): link holder can sign recipient = escrow itself (e.g. a UI bug / paste
    /// error). Funds are then locked forever: status=Claimed, balance stays in escrow, no sweep.
    function test_atk_recipientIsEscrowOrToken_rejected() public {
        uint256 id = _mk(alice, link, AMT);
        bytes memory sigE = _sig(escrow, linkPk, id, address(escrow));
        vm.expectRevert(LinkEscrow.ZeroRecipient.selector);
        escrow.claimFor(id, address(escrow), sigE);
        bytes memory sigT = _sig(escrow, linkPk, id, address(token));
        vm.expectRevert(LinkEscrow.ZeroRecipient.selector);
        escrow.claimFor(id, address(token), sigT);
    }
}
