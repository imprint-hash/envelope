// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LinkEscrow} from "../contracts/LinkEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {FalseToken} from "./mocks/FalseToken.sol";

contract LinkEscrowTest is Test {
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    event Created(
        uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note
    );
    event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sender, uint256 amount);

    MockERC20 token;
    LinkEscrow escrow;

    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address relayer = makeAddr("relayer");
    address link;
    uint256 linkPk;

    uint256 constant AMOUNT = 50e18;

    function setUp() public {
        token = new MockERC20("Mezo USD");
        escrow = new LinkEscrow(address(token));
        (link, linkPk) = makeAddrAndKey("link");
        token.mint(sender, 1_000e18);
        vm.prank(sender);
        token.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _sign(uint256 pk, uint256 id, address to) internal view returns (bytes memory) {
        return _signOn(escrow, pk, id, to);
    }

    function _signOn(LinkEscrow e, uint256 pk, uint256 id, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.claimDigest(id, to));
        return abi.encodePacked(r, s, v);
    }

    function _create(uint256 amount, string memory note) internal returns (uint256 id) {
        vm.prank(sender);
        id = escrow.create(link, amount, note);
    }

    function _status(uint256 id) internal view returns (LinkEscrow.Status st) {
        (,, st,,) = escrow.deposits(id);
    }

    function _signPermit(MockERC20 t, uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(t.PERMIT_TYPEHASH(), owner, spender, value, t.nonces(owner), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---------------------------------------------------------------- create

    function test_Create_StoresDepositAndPullsFunds() public {
        uint256 id = _create(AMOUNT, "For mum's groceries");
        assertEq(id, 1);
        assertEq(escrow.nextId(), 2);

        (LinkEscrow.Deposit memory d, string memory note) = escrow.getDeposit(id);
        assertEq(d.sender, sender);
        assertEq(d.link, link);
        assertEq(uint256(d.amount), AMOUNT);
        assertEq(uint256(d.expiresAt), block.timestamp + 7 days);
        assertEq(uint8(d.status), uint8(LinkEscrow.Status.Open));
        assertEq(note, "For mum's groceries");

        uint256[] memory ids = escrow.idsOf(sender);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);

        assertEq(token.balanceOf(sender), 1_000e18 - AMOUNT);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_Create_EmitsCreated() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Created(1, sender, link, AMOUNT, uint64(block.timestamp + 7 days), "hi");
        _create(AMOUNT, "hi");
    }

    function test_CreateWithPermit_SingleTx() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("owner");
        token.mint(owner, 100e18);
        uint256 deadline = block.timestamp + 1800;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(token, ownerPk, owner, address(escrow), AMOUNT, deadline);

        vm.prank(owner);
        uint256 id = escrow.createWithPermit(link, AMOUNT, "", deadline, v, r, s);

        assertEq(id, 1);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(token.balanceOf(owner), 50e18);
        assertEq(token.allowance(owner, address(escrow)), 0);
    }

    function test_CreateWithPermit_FrontrunPermitStillWorks() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("owner");
        token.mint(owner, 100e18);
        uint256 deadline = block.timestamp + 1800;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(token, ownerPk, owner, address(escrow), AMOUNT, deadline);

        // attacker submits the permit first
        vm.prank(makeAddr("attacker"));
        token.permit(owner, address(escrow), AMOUNT, deadline, v, r, s);

        vm.prank(owner);
        uint256 id = escrow.createWithPermit(link, AMOUNT, "", deadline, v, r, s);
        assertEq(id, 1);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_RevertWhen_ZeroAmount() public {
        vm.prank(sender);
        vm.expectRevert(LinkEscrow.ZeroAmount.selector);
        escrow.create(link, 0, "");
    }

    function test_RevertWhen_ZeroLink() public {
        vm.prank(sender);
        vm.expectRevert(LinkEscrow.ZeroLink.selector);
        escrow.create(address(0), AMOUNT, "");
    }

    function test_RevertWhen_AmountTooLarge() public {
        vm.prank(sender);
        vm.expectRevert(LinkEscrow.AmountTooLarge.selector);
        escrow.create(link, uint256(type(uint96).max) + 1, "");
    }

    function test_RevertWhen_NoteTooLong() public {
        bytes memory b = new bytes(141);
        for (uint256 i; i < 141; i++) {
            b[i] = "a";
        }
        vm.prank(sender);
        vm.expectRevert(LinkEscrow.NoteTooLong.selector);
        escrow.create(link, AMOUNT, string(b));

        // exactly 140 is fine
        bytes memory ok = new bytes(140);
        for (uint256 i; i < 140; i++) {
            ok[i] = "a";
        }
        vm.prank(sender);
        escrow.create(link, AMOUNT, string(ok));
    }

    function test_RevertWhen_NoAllowance() public {
        address poor = makeAddr("noApproval");
        token.mint(poor, 100e18);
        vm.prank(poor);
        vm.expectRevert(LinkEscrow.TransferFailed.selector);
        escrow.create(link, AMOUNT, "");
    }

    // ---------------------------------------------------------------- claim

    function test_Claim_HappyPath() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        uint256 relayerBefore = token.balanceOf(relayer);

        vm.prank(relayer);
        escrow.claimFor(id, recipient, sig);

        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(token.balanceOf(relayer), relayerBefore);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(id)), uint8(LinkEscrow.Status.Claimed));
    }

    function test_Claim_EmitsClaimed() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Claimed(id, recipient, relayer, AMOUNT);
        vm.prank(relayer);
        escrow.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_DoubleClaim() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        escrow.claimFor(id, recipient, sig);
        vm.expectRevert(LinkEscrow.AlreadyClaimed.selector);
        escrow.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_ClaimAfterRefund() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        vm.warp(block.timestamp + 7 days);
        escrow.refund(id);
        vm.expectRevert(LinkEscrow.AlreadyRefunded.selector);
        escrow.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_ClaimAfterExpiry() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        (, uint64 expiresAt,,,) = escrow.deposits(id);
        vm.warp(expiresAt);
        vm.expectRevert(LinkEscrow.Expired.selector);
        escrow.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_ClaimNonexistent() public {
        bytes memory sig0 = _sign(linkPk, 0, recipient);
        vm.expectRevert(LinkEscrow.NotFound.selector);
        escrow.claimFor(0, recipient, sig0);

        bytes memory sig999 = _sign(linkPk, 999, recipient);
        vm.expectRevert(LinkEscrow.NotFound.selector);
        escrow.claimFor(999, recipient, sig999);
    }

    function test_RevertWhen_WrongSigner() public {
        uint256 id = _create(AMOUNT, "");
        (, uint256 otherPk) = makeAddrAndKey("random");
        bytes memory sig = _sign(otherPk, id, recipient);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_SigForOtherRecipient() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        vm.prank(relayer);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, relayer, sig);
    }

    function test_RevertWhen_SigReplayedOnOtherId() public {
        uint256 id1 = _create(AMOUNT, "");
        uint256 id2 = _create(AMOUNT, "");
        bytes memory sig1 = _sign(linkPk, id1, recipient);
        escrow.claimFor(id1, recipient, sig1);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id2, recipient, sig1);
    }

    function test_RevertWhen_SigForOtherChain() public {
        uint256 id = _create(AMOUNT, "");
        uint256 home = block.chainid;
        vm.chainId(1);
        bytes memory sig = _sign(linkPk, id, recipient);
        vm.chainId(home);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_SigForOtherContract() public {
        LinkEscrow escrow2 = new LinkEscrow(address(token));
        vm.prank(sender);
        token.approve(address(escrow2), type(uint256).max);
        _create(AMOUNT, "");
        vm.prank(sender);
        uint256 id2 = escrow2.create(link, AMOUNT, "");
        assertEq(id2, 1);

        bytes memory sigOnFirst = _sign(linkPk, 1, recipient);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow2.claimFor(1, recipient, sigOnFirst);
    }

    function test_RevertWhen_MalleableHighS() public {
        uint256 id = _create(AMOUNT, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, escrow.claimDigest(id, recipient));
        bytes32 highS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        // sanity: the malleable form recovers to the same key
        assertEq(ecrecover(escrow.claimDigest(id, recipient), flippedV, r, highS), link);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, recipient, abi.encodePacked(r, highS, flippedV));
    }

    function test_RevertWhen_BadSigLength() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, recipient);
        bytes memory short_ = new bytes(64);
        for (uint256 i; i < 64; i++) {
            short_[i] = sig[i];
        }
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, recipient, short_);

        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, recipient, abi.encodePacked(sig, bytes1(0x00)));
    }

    function test_RevertWhen_InvalidV() public {
        uint256 id = _create(AMOUNT, "");
        (, bytes32 r, bytes32 s) = vm.sign(linkPk, escrow.claimDigest(id, recipient));
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, recipient, abi.encodePacked(r, s, uint8(29)));
    }

    function test_RevertWhen_ZeroRecipient() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(linkPk, id, address(0));
        vm.expectRevert(LinkEscrow.ZeroRecipient.selector);
        escrow.claimFor(id, address(0), sig);
    }

    // ---------------------------------------------------------------- refund

    function test_Refund_AfterExpiry() public {
        uint256 id = _create(AMOUNT, "");
        vm.warp(block.timestamp + 7 days);
        address stranger = makeAddr("stranger");
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Refunded(id, sender, AMOUNT);
        vm.prank(stranger);
        escrow.refund(id);
        assertEq(token.balanceOf(sender), 1_000e18);
        assertEq(token.balanceOf(stranger), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(id)), uint8(LinkEscrow.Status.Refunded));
    }

    function test_RevertWhen_RefundBeforeExpiry() public {
        uint256 id = _create(AMOUNT, "");
        (, uint64 expiresAt,,,) = escrow.deposits(id);
        vm.warp(uint256(expiresAt) - 1);
        vm.expectRevert(LinkEscrow.NotExpired.selector);
        escrow.refund(id);
    }

    function test_RevertWhen_RefundAfterClaim() public {
        uint256 id = _create(AMOUNT, "");
        escrow.claimFor(id, recipient, _sign(linkPk, id, recipient));
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(LinkEscrow.AlreadyClaimed.selector);
        escrow.refund(id);
    }

    function test_RevertWhen_DoubleRefund() public {
        uint256 id = _create(AMOUNT, "");
        vm.warp(block.timestamp + 7 days);
        escrow.refund(id);
        vm.expectRevert(LinkEscrow.AlreadyRefunded.selector);
        escrow.refund(id);
    }

    // ---------------------------------------------------------------- reentrancy / token safety

    function test_Reentrancy_OnClaim() public {
        ReentrantToken rt = new ReentrantToken();
        LinkEscrow e = new LinkEscrow(address(rt));
        rt.mint(sender, 100e18);
        vm.startPrank(sender);
        rt.approve(address(e), type(uint256).max);
        uint256 id = e.create(link, AMOUNT, "");
        vm.stopPrank();
        bytes memory sig = _signOn(e, linkPk, id, recipient);

        // re-enter claimFor during the payout transfer
        rt.arm(address(e), abi.encodeCall(LinkEscrow.claimFor, (id, recipient, sig)), true, false);
        vm.expectRevert(LinkEscrow.TransferFailed.selector); // inner Reentrancy() makes the token call fail; escrow surfaces TransferFailed
        e.claimFor(id, recipient, sig);

        // re-enter refund during the payout transfer
        rt.arm(address(e), abi.encodeCall(LinkEscrow.refund, (id)), true, false);
        vm.expectRevert(LinkEscrow.TransferFailed.selector); // inner Reentrancy() makes the token call fail; escrow surfaces TransferFailed
        e.claimFor(id, recipient, sig);

        assertEq(rt.balanceOf(address(e)), AMOUNT);
        (LinkEscrow.Deposit memory d,) = e.getDeposit(id);
        assertEq(uint8(d.status), uint8(LinkEscrow.Status.Open));
    }

    function test_Reentrancy_OnCreate() public {
        ReentrantToken rt = new ReentrantToken();
        LinkEscrow e = new LinkEscrow(address(rt));
        rt.mint(sender, 100e18);
        vm.prank(sender);
        rt.approve(address(e), type(uint256).max);

        rt.arm(address(e), abi.encodeCall(LinkEscrow.create, (link, 1e18, "")), false, true);
        vm.prank(sender);
        vm.expectRevert(LinkEscrow.TransferFailed.selector); // inner Reentrancy() makes the token call fail; escrow surfaces TransferFailed
        e.create(link, AMOUNT, "");

        assertEq(rt.balanceOf(address(e)), 0);
        assertEq(e.nextId(), 1);
        assertEq(e.idsOf(sender).length, 0);
    }

    function test_RevertWhen_TokenReturnsFalse() public {
        FalseToken ft = new FalseToken();
        LinkEscrow e = new LinkEscrow(address(ft));
        vm.prank(sender);
        vm.expectRevert(LinkEscrow.TransferFailed.selector);
        e.create(link, AMOUNT, "");
    }

    function test_RevertWhen_TokenNotAContract() public {
        vm.expectRevert(LinkEscrow.NotAContract.selector);
        new LinkEscrow(makeAddr("eoa"));
    }

    // ---------------------------------------------------------------- EIP-712 parity with ethers v6

    address constant FIXED_ESCROW = 0x00000000000000000000000000000000000e5c40;
    address constant FIXED_RECIPIENT = 0x000000000000000000000000000000000000bEEF;
    // node: TypedDataEncoder.hashDomain({name:"LinkEscrow",version:"1",chainId:31611,verifyingContract:FIXED_ESCROW})
    bytes32 constant ETHERS_DOMAIN_SEP = 0x9c85d7368c83f9186fae8f7948b0c8c778a2dd701175cc9a5fa6a17b8cb5b242;
    // node: TypedDataEncoder.hash(domain, {Claim:[{id,uint256},{recipient,address}]}, {id:1n, recipient:FIXED_RECIPIENT})
    bytes32 constant ETHERS_DIGEST = 0xec59f6f7aae96a5b31ad3a9f23cef387e4a3b76db4adaa1ad0674d56893e84d4;

    function _fixedEscrow() internal returns (LinkEscrow e) {
        vm.chainId(31611);
        deployCodeTo("LinkEscrow.sol:LinkEscrow", abi.encode(address(token)), FIXED_ESCROW);
        e = LinkEscrow(FIXED_ESCROW);
    }

    function test_DomainSeparator_MatchesManual() public {
        LinkEscrow e = _fixedEscrow();
        bytes32 manual = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("LinkEscrow"),
                keccak256("1"),
                uint256(31611),
                FIXED_ESCROW
            )
        );
        assertEq(e.DOMAIN_SEPARATOR(), manual);
        assertEq(e.DOMAIN_SEPARATOR(), ETHERS_DOMAIN_SEP);
        assertEq(e.CLAIM_TYPEHASH(), keccak256("Claim(uint256 id,address recipient)"));
    }

    function test_ClaimDigest_MatchesEthersFormat() public {
        LinkEscrow e = _fixedEscrow();
        assertEq(e.claimDigest(1, FIXED_RECIPIENT), ETHERS_DIGEST);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_ClaimOnlyByLinkKey(uint256 pk, address to) public {
        pk = bound(pk, 1, N - 1);
        vm.assume(vm.addr(pk) != link);
        vm.assume(to != address(0));
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sign(pk, id, to);
        vm.expectRevert(LinkEscrow.BadSignature.selector);
        escrow.claimFor(id, to, sig);
        assertEq(uint8(_status(id)), uint8(LinkEscrow.Status.Open));
    }
}
