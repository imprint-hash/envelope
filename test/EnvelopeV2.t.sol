// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EnvelopeV2} from "../contracts/EnvelopeV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {FalseToken} from "./mocks/FalseToken.sol";

/// @notice Token that burns 1% of every incoming transferFrom (fee-on-transfer).
contract BurnOnTransferToken is MockERC20 {
    constructor() MockERC20("Burn") {}

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        uint256 burn = amount / 100;
        balanceOf[to] -= burn;
        totalSupply -= burn;
        return true;
    }
}

/// @notice Shared helpers for the V2 suites.
abstract contract EnvelopeV2Base is Test {
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant FEE_BPS = 50;
    uint256 constant REWARD = 0.05e18;

    function _sigClaim(EnvelopeV2 e, uint256 pk, uint256 id, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.claimDigest(id, to));
        return abi.encodePacked(r, s, v);
    }

    function _args(address from, address l, uint256 amount, uint256 deadline, string memory note)
        internal
        pure
        returns (EnvelopeV2.CreateForArgs memory)
    {
        return EnvelopeV2.CreateForArgs({sender: from, link: l, amount: amount, deadline: deadline, note: note});
    }

    function _sigCreateFor(EnvelopeV2 e, uint256 pk, EnvelopeV2.CreateForArgs memory a, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = e.createForDigest(a.sender, a.link, a.amount, keccak256(bytes(a.note)), nonce, a.deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _permit(MockERC20 t, uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (EnvelopeV2.PermitArgs memory p)
    {
        bytes32 structHash =
            keccak256(abi.encode(t.PERMIT_TYPEHASH(), owner, spender, value, t.nonces(owner), deadline));
        (p.v, p.r, p.s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash)));
        p.deadline = deadline;
    }

    function _noPermit() internal pure returns (EnvelopeV2.PermitArgs memory p) {}

    function _total(EnvelopeV2 e, uint256 amount) internal view returns (uint256 t) {
        (t,) = e.quote(amount);
    }
}

contract EnvelopeV2Test is EnvelopeV2Base {
    event Created(
        uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note
    );
    event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sender, uint256 amount);
    event FeeTaken(uint256 indexed id, uint256 fee);
    event RelayerPaid(address indexed relayer, uint256 amount);
    event Swept(uint256 amount);

    MockERC20 token;
    EnvelopeV2 env;

    address sender;
    uint256 senderPk;
    address link;
    uint256 linkPk;
    address recipient = makeAddr("recipient");
    address relayer = makeAddr("relayer");
    address treasury = makeAddr("treasury");
    address mallory = makeAddr("mallory");

    uint256 constant START = 100_000e18;
    uint256 constant AMOUNT = 50e18; // what the recipient gets
    uint256 constant FEE = 0.25e18; // 0.5% on top
    uint256 constant TOTAL = AMOUNT + FEE; // what the sender pays

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockERC20("Mezo USD");
        env = new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD);
        (sender, senderPk) = makeAddrAndKey("sender");
        (link, linkPk) = makeAddrAndKey("link");
        token.mint(sender, START);
        vm.prank(sender);
        token.approve(address(env), type(uint256).max);
    }

    function _create(uint256 amount, string memory note) internal returns (uint256 id) {
        vm.prank(sender);
        id = env.create(link, amount, note);
    }

    function _status(uint256 id) internal view returns (EnvelopeV2.Status st) {
        (,, st,,) = env.deposits(id);
    }

    /// Fresh signer with no approval, funded, for createFor tests.
    function _freshSender() internal returns (address who, uint256 pk) {
        (who, pk) = makeAddrAndKey("borrower");
        token.mint(who, 1_000e18);
    }

    function _createForSigned(address who, uint256 pk, uint256 amount, string memory note)
        internal
        view
        returns (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p)
    {
        a = _args(who, link, amount, block.timestamp + 1 hours, note);
        auth = _sigCreateFor(env, pk, a, env.nonces(who));
        p = _permit(token, pk, who, address(env), _total(env, amount), block.timestamp + 1 hours);
    }

    // ================================================================ constructor

    function test_Constructor_StoresConfig() public view {
        assertEq(env.token(), address(token));
        assertEq(env.treasury(), treasury);
        assertEq(env.FEE_BPS(), 50);
        assertEq(env.relayerReward(), REWARD);
        assertEq(env.sweepBuffer(), REWARD * 100);
        assertEq(env.nextId(), 1);
        assertEq(env.gasFund(), 0);
    }

    function test_Constructor_AllowsCapExactly() public {
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, 100, 1e18);
        assertEq(e.FEE_BPS(), 100);
        assertEq(e.relayerReward(), 1e18);
    }

    function test_RevertWhen_Constructor_TokenNotAContract() public {
        vm.expectRevert(EnvelopeV2.NotAContract.selector);
        new EnvelopeV2(makeAddr("eoa"), treasury, FEE_BPS, REWARD);
    }

    function test_RevertWhen_Constructor_ZeroTreasury() public {
        vm.expectRevert(EnvelopeV2.ZeroAddress.selector);
        new EnvelopeV2(address(token), address(0), FEE_BPS, REWARD);
    }

    function test_RevertWhen_Constructor_FeeAboveCap() public {
        vm.expectRevert(EnvelopeV2.FeeTooHigh.selector);
        new EnvelopeV2(address(token), treasury, 101, REWARD);
    }

    function test_RevertWhen_Constructor_RewardAboveCap() public {
        vm.expectRevert(EnvelopeV2.RewardTooHigh.selector);
        new EnvelopeV2(address(token), treasury, FEE_BPS, 1e18 + 1);
    }

    // ================================================================ views

    function test_FeeFor_And_Quote() public view {
        assertEq(env.feeFor(AMOUNT), FEE);
        (uint256 total, uint256 fee) = env.quote(AMOUNT);
        assertEq(total, TOTAL);
        assertEq(fee, FEE);
        // rounds UP so the protocol never under-collects
        assertEq(env.feeFor(0), 0);
        assertEq(env.feeFor(1), 1);
        assertEq(env.feeFor(200), 1);
        assertEq(env.feeFor(201), 2);
    }

    function test_Nonces_StartAtZero() public view {
        assertEq(env.nonces(sender), 0);
    }

    function test_DomainSeparator_MatchesManual() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Envelope"),
                keccak256("2"),
                block.chainid,
                address(env)
            )
        );
        assertEq(env.DOMAIN_SEPARATOR(), expected);
    }

    function test_CreateForDigest_MatchesManual() public view {
        bytes32 typehash = keccak256(
            "CreateFor(address sender,address link,uint256 amount,bytes32 noteHash,uint256 nonce,uint256 deadline)"
        );
        assertEq(env.CREATE_FOR_TYPEHASH(), typehash);
        bytes32 nh = keccak256("hi");
        bytes32 expected = keccak256(
            abi.encodePacked(
                "\x19\x01", env.DOMAIN_SEPARATOR(), keccak256(abi.encode(typehash, sender, link, AMOUNT, nh, 7, 99))
            )
        );
        assertEq(env.createForDigest(sender, link, AMOUNT, nh, 7, 99), expected);
    }

    function test_ClaimDigest_MatchesManual() public view {
        bytes32 expected = keccak256(
            abi.encodePacked(
                "\x19\x01",
                env.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(keccak256("Claim(uint256 id,address recipient)"), uint256(3), recipient))
            )
        );
        assertEq(env.claimDigest(3, recipient), expected);
    }

    function test_ClaimSig_FromV1DomainDoesNotWorkOnV2() public {
        uint256 id = _create(AMOUNT, "");
        bytes32 v1Domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("LinkEscrow"),
                keccak256("1"),
                block.chainid,
                address(env)
            )
        );
        bytes32 d = keccak256(
            abi.encodePacked("\x19\x01", v1Domain, keccak256(abi.encode(env.CLAIM_TYPEHASH(), id, recipient)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, d);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, abi.encodePacked(r, s, v));
    }

    // ================================================================ create

    function test_Create_StoresAmountAndBooksFeeOnTop() public {
        uint256 id = _create(AMOUNT, "For mum's groceries");
        assertEq(id, 1);
        assertEq(env.nextId(), 2);
        (EnvelopeV2.Deposit memory d, string memory note) = env.getDeposit(id);
        assertEq(d.sender, sender);
        assertEq(d.link, link);
        assertEq(uint256(d.amount), AMOUNT);
        assertEq(uint256(d.expiresAt), block.timestamp + 7 days);
        assertEq(uint8(d.status), uint8(EnvelopeV2.Status.Open));
        assertEq(note, "For mum's groceries");
        assertEq(env.gasFund(), FEE);
        assertEq(token.balanceOf(address(env)), TOTAL);
        assertEq(token.balanceOf(sender), START - TOTAL);
        uint256[] memory ids = env.idsOf(sender);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
    }

    function test_Create_EmitsCreatedAndFeeTaken() public {
        vm.expectEmit(true, true, true, true, address(env));
        emit Created(1, sender, link, AMOUNT, uint64(block.timestamp + 7 days), "hi");
        vm.expectEmit(true, false, false, true, address(env));
        emit FeeTaken(1, FEE);
        _create(AMOUNT, "hi");
    }

    function test_Create_DustAmountStillPaysOneWei() public {
        uint256 id = _create(1, "");
        assertEq(env.gasFund(), 1);
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        assertEq(uint256(d.amount), 1);
        assertEq(token.balanceOf(sender), START - 2);
    }

    function test_Create_ZeroFeeContract() public {
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, 0, REWARD);
        vm.startPrank(sender);
        token.approve(address(e), type(uint256).max);
        vm.recordLogs();
        uint256 id = e.create(link, AMOUNT, "");
        assertEq(vm.getRecordedLogs().length, 2); // Created + token Transfer, no FeeTaken
        vm.stopPrank();
        assertEq(e.gasFund(), 0);
        bytes memory cs = _sigClaim(e, linkPk, id, recipient);
        vm.prank(relayer);
        e.claimFor(id, recipient, cs);
        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(token.balanceOf(relayer), 0);
    }

    function test_RevertWhen_Create_ZeroAmount() public {
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.ZeroAmount.selector);
        env.create(link, 0, "");
    }

    function test_RevertWhen_Create_ZeroLink() public {
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.ZeroLink.selector);
        env.create(address(0), AMOUNT, "");
    }

    function test_RevertWhen_Create_AmountTooLarge() public {
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.AmountTooLarge.selector);
        env.create(link, uint256(type(uint96).max) + 1, "");
        // amount fits in uint96 but amount + fee does not
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.AmountTooLarge.selector);
        env.create(link, type(uint96).max, "");
    }

    function test_Create_LargestAmountThatFits() public {
        // largest a with a + ceil(a * 50 / 10_000) <= type(uint96).max
        uint256 maxTotal = type(uint96).max;
        uint256 a = maxTotal * 10_000 / 10_050;
        while (_total(env, a + 1) <= maxTotal) a++;
        while (_total(env, a) > maxTotal) a--;
        token.mint(sender, _total(env, a));
        uint256 id = _create(a, "");
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        assertEq(uint256(d.amount), a);
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.AmountTooLarge.selector);
        env.create(link, a + 1, "");
    }

    function test_RevertWhen_Create_NoteTooLong() public {
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.NoteTooLong.selector);
        env.create(link, AMOUNT, string(new bytes(141)));
        vm.prank(sender);
        env.create(link, AMOUNT, string(new bytes(140))); // exactly 140 is fine
    }

    function test_RevertWhen_Create_NoAllowance() public {
        vm.prank(mallory);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        env.create(link, AMOUNT, "");
    }

    function test_RevertWhen_Create_AllowanceCoversAmountButNotFee() public {
        (address who,) = _freshSender();
        vm.startPrank(who);
        token.approve(address(env), AMOUNT);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        env.create(link, AMOUNT, "");
        vm.stopPrank();
    }

    function test_RevertWhen_Create_TokenReturnsFalse() public {
        FalseToken ft = new FalseToken();
        EnvelopeV2 e = new EnvelopeV2(address(ft), treasury, FEE_BPS, REWARD);
        vm.prank(sender);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        e.create(link, AMOUNT, "");
    }

    function test_RevertWhen_Create_FeeOnTransferToken() public {
        BurnOnTransferToken bt = new BurnOnTransferToken();
        EnvelopeV2 e = new EnvelopeV2(address(bt), treasury, FEE_BPS, REWARD);
        bt.mint(sender, TOTAL);
        vm.startPrank(sender);
        bt.approve(address(e), type(uint256).max);
        vm.expectRevert(EnvelopeV2.WrongAmountReceived.selector);
        e.create(link, AMOUNT, "");
        vm.stopPrank();
    }

    // ================================================================ createWithPermit

    function test_CreateWithPermit_SingleTx() public {
        (address who, uint256 pk) = _freshSender();
        EnvelopeV2.PermitArgs memory p = _permit(token, pk, who, address(env), TOTAL, block.timestamp + 1 hours);
        vm.prank(who);
        uint256 id = env.createWithPermit(link, AMOUNT, "", p.deadline, p.v, p.r, p.s);
        assertEq(token.balanceOf(address(env)), TOTAL);
        assertEq(token.balanceOf(who), 1_000e18 - TOTAL);
        assertEq(env.gasFund(), FEE);
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        assertEq(d.sender, who);
        assertEq(uint256(d.amount), AMOUNT);
    }

    function test_CreateWithPermit_FrontRunPermitStillWorks() public {
        (address who, uint256 pk) = _freshSender();
        EnvelopeV2.PermitArgs memory p = _permit(token, pk, who, address(env), TOTAL, block.timestamp + 1 hours);
        token.permit(who, address(env), TOTAL, p.deadline, p.v, p.r, p.s); // front-runner
        vm.prank(who);
        env.createWithPermit(link, AMOUNT, "", p.deadline, p.v, p.r, p.s);
        assertEq(token.balanceOf(address(env)), TOTAL);
    }

    function test_RevertWhen_CreateWithPermit_PermitOnlyForAmount() public {
        // permit signed for the envelope amount, forgetting the fee -> not enough
        (address who, uint256 pk) = _freshSender();
        EnvelopeV2.PermitArgs memory p = _permit(token, pk, who, address(env), AMOUNT, block.timestamp + 1 hours);
        vm.prank(who);
        vm.expectRevert(EnvelopeV2.PermitFailed.selector);
        env.createWithPermit(link, AMOUNT, "", p.deadline, p.v, p.r, p.s);
    }

    // ================================================================ createFor

    function test_CreateFor_HappyPath() public {
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, AMOUNT, "rent");

        vm.expectEmit(true, true, true, true, address(env));
        emit Created(1, who, link, AMOUNT, uint64(block.timestamp + 7 days), "rent");
        vm.expectEmit(true, false, false, true, address(env));
        emit FeeTaken(1, FEE);
        vm.expectEmit(true, false, false, true, address(env));
        emit RelayerPaid(relayer, REWARD);
        vm.prank(relayer);
        uint256 id = env.createFor(a, auth, p);

        assertEq(id, 1);
        assertEq(env.nonces(who), 1);
        (EnvelopeV2.Deposit memory d, string memory note) = env.getDeposit(id);
        assertEq(d.sender, who);
        assertEq(d.link, link);
        assertEq(uint256(d.amount), AMOUNT);
        assertEq(note, "rent");
        assertEq(env.idsOf(who)[0], id);
        assertEq(token.balanceOf(who), 1_000e18 - TOTAL);
        assertEq(token.balanceOf(relayer), REWARD); // fee/2 = 0.125 > reward 0.05
        assertEq(env.gasFund(), FEE - REWARD);
        assertEq(token.balanceOf(address(env)), AMOUNT + env.gasFund());
    }

    function test_CreateFor_RewardCappedAtHalfFee() public {
        (address who, uint256 pk) = _freshSender();
        uint256 amount = 10e18; // fee 0.05, half = 0.025 < reward 0.05
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, amount, "");
        vm.prank(relayer);
        env.createFor(a, auth, p);
        assertEq(token.balanceOf(relayer), 0.025e18);
        assertEq(env.gasFund(), 0.025e18);
    }

    function test_CreateFor_DeadlineInclusive() public {
        (address who, uint256 pk) = _freshSender();
        EnvelopeV2.CreateForArgs memory a = _args(who, link, AMOUNT, block.timestamp, "");
        bytes memory auth = _sigCreateFor(env, pk, a, 0);
        EnvelopeV2.PermitArgs memory p = _permit(token, pk, who, address(env), TOTAL, block.timestamp);
        vm.prank(relayer);
        env.createFor(a, auth, p);
        assertEq(env.nonces(who), 1);
    }

    function test_CreateFor_WithExistingAllowanceAndNoPermit() public {
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        vm.prank(relayer);
        env.createFor(a, auth, _noPermit());
        assertEq(token.balanceOf(address(env)), TOTAL - REWARD);
        assertEq(token.balanceOf(sender), START - TOTAL);
    }

    function test_CreateFor_SequentialNonces() public {
        (address who, uint256 pk) = _freshSender();
        for (uint256 i; i < 3; i++) {
            (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
                _createForSigned(who, pk, AMOUNT, "");
            vm.prank(relayer);
            env.createFor(a, auth, p);
        }
        assertEq(env.nonces(who), 3);
        assertEq(env.idsOf(who).length, 3);
    }

    function test_RevertWhen_CreateFor_Expired() public {
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, AMOUNT, "");
        vm.warp(a.deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(EnvelopeV2.SignatureExpired.selector);
        env.createFor(a, auth, p);
    }

    function test_RevertWhen_CreateFor_ZeroSender() public {
        EnvelopeV2.CreateForArgs memory a = _args(address(0), link, AMOUNT, block.timestamp + 1, "");
        vm.expectRevert(EnvelopeV2.ZeroAddress.selector);
        env.createFor(a, new bytes(65), _noPermit());
    }

    function test_RevertWhen_CreateFor_WrongSigner() public {
        (address who,) = _freshSender();
        (, uint256 malloryPk) = makeAddrAndKey("mallory-key");
        EnvelopeV2.CreateForArgs memory a = _args(who, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, malloryPk, a, 0);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_RevertWhen_CreateFor_ReplayedAuthSig() public {
        // sender has unlimited approval, so only the nonce stops a replay
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1 hours, "");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        vm.prank(relayer);
        env.createFor(a, auth, _noPermit());
        vm.prank(relayer);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
        assertEq(env.nextId(), 2);
    }

    function test_RevertWhen_CreateFor_RelayerSwapsLink() public {
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, AMOUNT, "");
        a.link = mallory;
        vm.prank(relayer);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, p);
    }

    function test_RevertWhen_CreateFor_RelayerChangesAmount() public {
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        a.amount = AMOUNT * 10;
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_RevertWhen_CreateFor_RelayerChangesNote() public {
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "love, mum");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        a.note = "send it back to me";
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_RevertWhen_CreateFor_RelayerExtendsDeadline() public {
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        a.deadline += 1 days;
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_RevertWhen_CreateFor_SigFromOtherContract() public {
        EnvelopeV2 other = new EnvelopeV2(address(token), treasury, FEE_BPS, REWARD);
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(other, senderPk, a, 0);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_RevertWhen_CreateFor_SigForOtherChain() public {
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        vm.chainId(1);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_RevertWhen_CreateFor_PermitOnlyCoversAmount() public {
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth,) = _createForSigned(who, pk, AMOUNT, "");
        EnvelopeV2.PermitArgs memory bad = _permit(token, pk, who, address(env), AMOUNT, block.timestamp + 1 hours);
        vm.expectRevert(EnvelopeV2.PermitFailed.selector);
        env.createFor(a, auth, bad);
        assertEq(env.nonces(who), 0); // whole call reverted
    }

    function test_RevertWhen_CreateFor_InsufficientBalance() public {
        (address who, uint256 pk) = makeAddrAndKey("broke");
        token.mint(who, AMOUNT); // enough for the envelope, not the fee
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, AMOUNT, "");
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        env.createFor(a, auth, p);
    }

    function test_RevertWhen_CreateFor_ValidationErrors() public {
        EnvelopeV2.CreateForArgs memory a = _args(sender, address(0), AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, senderPk, a, 0);
        vm.expectRevert(EnvelopeV2.ZeroLink.selector);
        env.createFor(a, auth, _noPermit());

        a = _args(sender, link, 0, block.timestamp + 1, "");
        auth = _sigCreateFor(env, senderPk, a, 0);
        vm.expectRevert(EnvelopeV2.ZeroAmount.selector);
        env.createFor(a, auth, _noPermit());

        a = _args(sender, link, type(uint96).max, block.timestamp + 1, "");
        auth = _sigCreateFor(env, senderPk, a, 0);
        vm.expectRevert(EnvelopeV2.AmountTooLarge.selector);
        env.createFor(a, auth, _noPermit());

        a = _args(sender, link, AMOUNT, block.timestamp + 1, string(new bytes(141)));
        auth = _sigCreateFor(env, senderPk, a, 0);
        vm.expectRevert(EnvelopeV2.NoteTooLong.selector);
        env.createFor(a, auth, _noPermit());
    }

    function test_CreateFor_FrontRunPermitThenCreateForStillWorks() public {
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, AMOUNT, "");
        // Mallory copies the permit out of the mempool and submits it first.
        vm.prank(mallory);
        token.permit(who, address(env), TOTAL, p.deadline, p.v, p.r, p.s);
        vm.prank(relayer);
        uint256 id = env.createFor(a, auth, p);
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        assertEq(d.link, link);
        assertEq(d.sender, who);
        assertEq(token.balanceOf(mallory), 0);
    }

    function test_CreateFor_FrontRunWholeCallOnlyMovesTheReward() public {
        // Copying the whole createFor makes the exact envelope the sender signed (same link);
        // the copier only earns the relayer reward and the original relay then reverts.
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, AMOUNT, "");
        vm.prank(mallory);
        env.createFor(a, auth, p);
        vm.prank(relayer);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, p);
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(1);
        assertEq(d.link, link);
        assertEq(env.nextId(), 2);
    }

    // ================================================================ claim

    function test_Claim_HappyPathPaysRecipientExactAmountAndRelayer() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, linkPk, id, recipient);
        vm.expectEmit(true, true, true, true, address(env));
        emit Claimed(id, recipient, relayer, AMOUNT);
        vm.expectEmit(true, false, false, true, address(env));
        emit RelayerPaid(relayer, REWARD);
        vm.prank(relayer);
        env.claimFor(id, recipient, sig);
        assertEq(token.balanceOf(recipient), AMOUNT);
        assertEq(token.balanceOf(relayer), REWARD);
        assertEq(env.gasFund(), FEE - REWARD);
        assertEq(uint8(_status(id)), uint8(EnvelopeV2.Status.Claimed));
        assertEq(token.balanceOf(address(env)), env.gasFund());
    }

    function test_Claim_CreateForPlusClaimPaysExactlyTheFee() public {
        (address who, uint256 pk) = _freshSender();
        (EnvelopeV2.CreateForArgs memory a, bytes memory auth, EnvelopeV2.PermitArgs memory p) =
            _createForSigned(who, pk, 10e18, "");
        vm.prank(relayer);
        uint256 id = env.createFor(a, auth, p);
        bytes memory cs = _sigClaim(env, linkPk, id, recipient);
        vm.prank(relayer);
        env.claimFor(id, recipient, cs);
        assertEq(token.balanceOf(relayer), env.feeFor(10e18));
        assertEq(env.gasFund(), 0);
        assertEq(token.balanceOf(recipient), 10e18);
    }

    function test_RevertWhen_Claim_Twice() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, linkPk, id, recipient);
        env.claimFor(id, recipient, sig);
        vm.expectRevert(EnvelopeV2.AlreadyClaimed.selector);
        env.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_Claim_AfterRefund() public {
        uint256 id = _create(AMOUNT, "");
        vm.warp(block.timestamp + 7 days);
        env.refund(id);
        bytes memory sig = _sigClaim(env, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.AlreadyRefunded.selector);
        env.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_Claim_AtExpiry() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, linkPk, id, recipient);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(EnvelopeV2.Expired.selector);
        env.claimFor(id, recipient, sig);
    }

    function test_RevertWhen_Claim_Nonexistent() public {
        bytes memory sig = _sigClaim(env, linkPk, 42, recipient);
        vm.expectRevert(EnvelopeV2.NotFound.selector);
        env.claimFor(42, recipient, sig);
    }

    function test_RevertWhen_Claim_WrongSigner() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory cs = _sigClaim(env, senderPk, id, recipient);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, cs);
    }

    function test_RevertWhen_Claim_RelayerRedirects() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, mallory, sig);
    }

    function test_RevertWhen_Claim_SigReplayedOnOtherId() public {
        uint256 id1 = _create(AMOUNT, "");
        uint256 id2 = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, linkPk, id1, recipient);
        env.claimFor(id1, recipient, sig);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id2, recipient, sig);
    }

    function test_RevertWhen_Claim_MalleableHighS() public {
        uint256 id = _create(AMOUNT, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, env.claimDigest(id, recipient));
        bytes32 highS = bytes32(N - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, abi.encodePacked(r, highS, flipped));
    }

    function test_RevertWhen_Claim_BadSigShapes() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, abi.encodePacked(sig, uint8(0))); // 66 bytes
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, new bytes(64));
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, new bytes(65)); // ecrecover -> 0
        sig[64] = bytes1(uint8(29));
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, recipient, sig);
    }

    function test_Claim_AcceptsVZeroOne() public {
        uint256 id = _create(AMOUNT, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(linkPk, env.claimDigest(id, recipient));
        env.claimFor(id, recipient, abi.encodePacked(r, s, v - 27));
        assertEq(token.balanceOf(recipient), AMOUNT);
    }

    function test_RevertWhen_Claim_BadRecipient() public {
        uint256 id = _create(AMOUNT, "");
        address[3] memory bad = [address(0), address(env), address(token)];
        for (uint256 i; i < 3; i++) {
            bytes memory sig = _sigClaim(env, linkPk, id, bad[i]);
            vm.expectRevert(EnvelopeV2.ZeroRecipient.selector);
            env.claimFor(id, bad[i], sig);
        }
    }

    // ================================================================ refund

    function test_Refund_AfterExpiryReturnsAmountKeepsFee() public {
        uint256 id = _create(AMOUNT, "");
        uint256 before = token.balanceOf(sender);
        vm.warp(block.timestamp + 7 days);
        vm.expectEmit(true, true, false, true, address(env));
        emit Refunded(id, sender, AMOUNT);
        vm.prank(mallory); // anyone may trigger; money goes to sender
        env.refund(id);
        assertEq(token.balanceOf(sender), before + AMOUNT);
        assertEq(token.balanceOf(mallory), 0);
        assertEq(env.gasFund(), FEE);
        assertEq(uint8(_status(id)), uint8(EnvelopeV2.Status.Refunded));
    }

    function test_RevertWhen_Refund_BeforeExpiry() public {
        uint256 id = _create(AMOUNT, "");
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(EnvelopeV2.NotExpired.selector);
        env.refund(id);
    }

    function test_RevertWhen_Refund_AfterClaim() public {
        uint256 id = _create(AMOUNT, "");
        bytes memory cs = _sigClaim(env, linkPk, id, recipient);
        env.claimFor(id, recipient, cs);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(EnvelopeV2.AlreadyClaimed.selector);
        env.refund(id);
    }

    function test_RevertWhen_Refund_Twice() public {
        uint256 id = _create(AMOUNT, "");
        vm.warp(block.timestamp + 7 days);
        env.refund(id);
        vm.expectRevert(EnvelopeV2.AlreadyRefunded.selector);
        env.refund(id);
    }

    function test_RevertWhen_Refund_Nonexistent() public {
        vm.expectRevert(EnvelopeV2.NotFound.selector);
        env.refund(0);
    }

    // ================================================================ sweep

    function test_Sweep_SendsSurplusToTreasuryOnly() public {
        _create(4_000e18, ""); // fee 20 MUSD, buffer 5 MUSD
        assertEq(env.gasFund(), 20e18);
        vm.expectEmit(false, false, false, true, address(env));
        emit Swept(15e18);
        vm.prank(mallory);
        uint256 swept = env.sweepSurplus();
        assertEq(swept, 15e18);
        assertEq(token.balanceOf(treasury), 15e18);
        assertEq(token.balanceOf(mallory), 0);
        assertEq(env.gasFund(), env.sweepBuffer());
        assertEq(token.balanceOf(address(env)), 4_000e18 + 5e18); // envelope untouched
    }

    function test_Sweep_DoesNotTouchEnvelopes() public {
        uint256 id = _create(4_000e18, "");
        env.sweepSurplus();
        bytes memory cs = _sigClaim(env, linkPk, id, recipient);
        env.claimFor(id, recipient, cs);
        assertEq(token.balanceOf(recipient), 4_000e18);
    }

    function test_RevertWhen_Sweep_NothingAboveBuffer() public {
        vm.expectRevert(EnvelopeV2.NothingToSweep.selector);
        env.sweepSurplus();
        _create(1_000e18, ""); // fee exactly 5 MUSD == buffer
        vm.expectRevert(EnvelopeV2.NothingToSweep.selector);
        env.sweepSurplus();
        _create(1, ""); // +1 wei fee
        assertEq(env.sweepSurplus(), 1);
    }

    function test_Sweep_ZeroRewardMeansZeroBuffer() public {
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, FEE_BPS, 0);
        vm.startPrank(sender);
        token.approve(address(e), type(uint256).max);
        e.create(link, AMOUNT, "");
        vm.stopPrank();
        assertEq(e.sweepSurplus(), FEE);
        assertEq(e.gasFund(), 0);
    }

    // ================================================================ relayer reward limits

    function test_RelayerReward_NeverExceedsGasFund() public {
        // 120 envelopes of 100 MUSD: fee 0.5 each, gasFund 60. Sweep leaves 5 = 100 rewards.
        uint256 n = 120;
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; i++) {
            ids[i] = _create(100e18, "");
        }
        env.sweepSurplus();
        assertEq(env.gasFund(), 5e18);
        for (uint256 i; i < n; i++) {
            bytes memory cs = _sigClaim(env, linkPk, ids[i], recipient);
            vm.prank(relayer);
            env.claimFor(ids[i], recipient, cs);
        }
        assertEq(token.balanceOf(relayer), 5e18); // only what the fund had
        assertEq(env.gasFund(), 0);
        assertEq(token.balanceOf(recipient), n * 100e18); // every claim paid in full
        assertEq(token.balanceOf(address(env)), 0);
    }

    function test_RelayerReward_PartialWhenFundLow() public {
        // fee 100 bps, reward 1 MUSD. 10 MUSD envelope: fee 0.1, claim cap 0.05.
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, 100, 1e18);
        vm.startPrank(sender);
        token.approve(address(e), type(uint256).max);
        uint256 id = e.create(link, 10e18, "");
        vm.stopPrank();
        bytes memory cs = _sigClaim(e, linkPk, id, recipient);
        vm.prank(relayer);
        e.claimFor(id, recipient, cs);
        assertEq(token.balanceOf(relayer), 0.05e18);
        assertEq(e.gasFund(), 0.05e18);
        assertEq(token.balanceOf(recipient), 10e18);
    }

    function test_RelayerReward_SelfRelayCannotDrainFund() public {
        _create(1_000e18, ""); // other people's fees
        uint256 seeded = env.gasFund();
        token.mint(mallory, 100e18);
        vm.startPrank(mallory);
        token.approve(address(env), type(uint256).max);
        uint256 start = token.balanceOf(mallory);
        for (uint256 i; i < 20; i++) {
            uint256 id = env.create(link, 1e18, "");
            bytes memory cs = _sigClaim(env, linkPk, id, mallory);
            env.claimFor(id, mallory, cs);
        }
        vm.stopPrank();
        assertLe(token.balanceOf(mallory), start); // farming is never profitable
        assertGe(env.gasFund(), seeded); // other people's fees untouched
    }

    // ================================================================ reentrancy

    function _reentrantEnv() internal returns (ReentrantToken rt, EnvelopeV2 e) {
        rt = new ReentrantToken();
        e = new EnvelopeV2(address(rt), treasury, FEE_BPS, REWARD);
        rt.mint(sender, 10_000e18);
        vm.prank(sender);
        rt.approve(address(e), type(uint256).max);
    }

    function test_Reentrancy_ClaimDuringClaim() public {
        (ReentrantToken rt, EnvelopeV2 e) = _reentrantEnv();
        vm.startPrank(sender);
        uint256 id1 = e.create(link, AMOUNT, "");
        uint256 id2 = e.create(link, AMOUNT, "");
        vm.stopPrank();
        rt.arm(
            address(e),
            abi.encodeCall(EnvelopeV2.claimFor, (id2, mallory, _sigClaim(e, linkPk, id2, mallory))),
            true,
            false
        );
        bytes memory sig1 = _sigClaim(e, linkPk, id1, recipient);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector); // inner Reentrancy() fails the token call
        e.claimFor(id1, recipient, sig1);
        assertEq(rt.balanceOf(mallory), 0);
        assertEq(rt.balanceOf(address(e)), 2 * TOTAL);
    }

    function test_Reentrancy_SweepDuringClaim() public {
        (ReentrantToken rt, EnvelopeV2 e) = _reentrantEnv();
        vm.prank(sender);
        uint256 id = e.create(link, 4_000e18, "");
        rt.arm(address(e), abi.encodeCall(EnvelopeV2.sweepSurplus, ()), true, false);
        bytes memory sig = _sigClaim(e, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        e.claimFor(id, recipient, sig);
        assertEq(e.gasFund(), 20e18);
    }

    function test_Reentrancy_RefundDuringCreateFor() public {
        (ReentrantToken rt, EnvelopeV2 e) = _reentrantEnv();
        vm.prank(sender);
        uint256 id = e.create(link, AMOUNT, "");
        vm.warp(block.timestamp + 7 days);
        rt.arm(address(e), abi.encodeCall(EnvelopeV2.refund, (id)), false, true);
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(e, senderPk, a, 0);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        e.createFor(a, auth, _noPermit());
        assertEq(e.nonces(sender), 0);
        assertEq(e.nextId(), 2);
    }

    function test_Reentrancy_CreateForDuringPayout() public {
        (ReentrantToken rt, EnvelopeV2 e) = _reentrantEnv();
        vm.prank(sender);
        uint256 id = e.create(link, AMOUNT, "");
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(e, senderPk, a, 0);
        rt.arm(address(e), abi.encodeCall(EnvelopeV2.createFor, (a, auth, _noPermit())), true, false);
        bytes memory sig = _sigClaim(e, linkPk, id, recipient);
        vm.expectRevert(EnvelopeV2.TransferFailed.selector);
        e.claimFor(id, recipient, sig);
        assertEq(e.nonces(sender), 0);
    }

    // ================================================================ fuzz

    function testFuzz_QuoteAddsUp(uint256 amount) public view {
        amount = bound(amount, 0, type(uint96).max);
        (uint256 total, uint256 fee) = env.quote(amount);
        assertEq(total, amount + fee);
        assertEq(fee, env.feeFor(amount));
        // fee is the exact ceiling of amount * 0.5%
        assertGe(fee * 10_000, amount * FEE_BPS);
        if (fee > 0) assertLt((fee - 1) * 10_000, amount * FEE_BPS);
    }

    function testFuzz_FeeRespectsCap(uint256 bps, uint256 amount) public {
        bps = bound(bps, 0, 100);
        amount = bound(amount, 0, type(uint96).max);
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, bps, REWARD);
        assertLe(e.feeFor(amount), (amount + 99) / 100); // never more than 1%, rounded up
    }

    function testFuzz_CreateAccounting(uint96 amount) public {
        amount = uint96(bound(amount, 1, 50_000e18));
        uint256 id = _create(amount, "");
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        assertEq(uint256(d.amount), amount);
        assertEq(env.gasFund(), env.feeFor(amount));
        assertEq(token.balanceOf(address(env)), uint256(amount) + env.gasFund());
        assertEq(token.balanceOf(sender), START - amount - env.feeFor(amount));
    }

    /// Any fee setting and amount: the recipient gets exactly `amount`, the sender pays exactly
    /// amount + fee, and one envelope's two relayer rewards never exceed its fee.
    function testFuzz_CreateForClaim_ExactAmountsAndRewardsBounded(uint256 bps, uint256 reward, uint96 amount) public {
        bps = bound(bps, 0, 100);
        reward = bound(reward, 0, 1e18);
        amount = uint96(bound(amount, 1, 1_000_000e18));
        EnvelopeV2 e = new EnvelopeV2(address(token), treasury, bps, reward);
        (address who, uint256 pk) = makeAddrAndKey("fz");
        (uint256 total, uint256 fee) = e.quote(amount);
        token.mint(who, total);
        EnvelopeV2.CreateForArgs memory a = _args(who, link, amount, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(e, pk, a, 0);
        EnvelopeV2.PermitArgs memory p = _permit(token, pk, who, address(e), total, block.timestamp + 1);
        vm.prank(relayer);
        uint256 id = e.createFor(a, auth, p);
        assertEq(token.balanceOf(who), 0);
        bytes memory cs = _sigClaim(e, linkPk, id, recipient);
        vm.prank(relayer);
        e.claimFor(id, recipient, cs);
        assertLe(token.balanceOf(relayer), fee);
        assertLe(token.balanceOf(relayer), 2 * reward);
        assertEq(token.balanceOf(recipient), amount);
        assertEq(token.balanceOf(address(e)), e.gasFund());
        assertEq(e.gasFund() + token.balanceOf(relayer), fee);
    }

    function testFuzz_ClaimOnlyByLinkKey(uint256 pk, address to) public {
        pk = bound(pk, 1, N - 1);
        vm.assume(pk != linkPk);
        vm.assume(to != address(0) && to != address(env) && to != address(token));
        uint256 id = _create(AMOUNT, "");
        bytes memory sig = _sigClaim(env, pk, id, to);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.claimFor(id, to, sig);
    }

    function testFuzz_CreateForOnlyBySender(uint256 pk) public {
        pk = bound(pk, 1, N - 1);
        vm.assume(pk != senderPk);
        EnvelopeV2.CreateForArgs memory a = _args(sender, link, AMOUNT, block.timestamp + 1, "");
        bytes memory auth = _sigCreateFor(env, pk, a, 0);
        vm.expectRevert(EnvelopeV2.BadSignature.selector);
        env.createFor(a, auth, _noPermit());
    }

    function testFuzz_SweepKeepsBuffer(uint96 a1, uint96 a2) public {
        a1 = uint96(bound(a1, 1, 40_000e18));
        a2 = uint96(bound(a2, 1, 40_000e18));
        _create(a1, "");
        _create(a2, "");
        uint256 fund = env.gasFund();
        if (fund <= env.sweepBuffer()) {
            vm.expectRevert(EnvelopeV2.NothingToSweep.selector);
            env.sweepSurplus();
        } else {
            assertEq(env.sweepSurplus(), fund - env.sweepBuffer());
            assertEq(env.gasFund(), env.sweepBuffer());
        }
        assertEq(token.balanceOf(address(env)), uint256(a1) + a2 + env.gasFund());
    }
}

// ==================================================================== invariant

contract EnvelopeV2Handler is EnvelopeV2Base {
    EnvelopeV2 public env;
    MockERC20 public token;

    uint256 constant ACTORS = 4;
    address[ACTORS] public actors;
    uint256[ACTORS] internal pks;
    address public link;
    uint256 internal linkPk;
    address public relayer = address(0xBEEF);

    uint256[] public ids;
    mapping(uint256 => uint256) public feeOf;
    mapping(uint256 => uint256) public rewardOf;
    uint256 public totalFees;
    uint256 public totalRewards;
    uint256 public totalSwept;
    uint256 public totalClaimed;
    uint256 public totalOpened;

    constructor(EnvelopeV2 env_, MockERC20 token_) {
        env = env_;
        token = token_;
        (link, linkPk) = makeAddrAndKey("inv-link");
        for (uint256 i; i < ACTORS; i++) {
            (actors[i], pks[i]) = makeAddrAndKey(string(abi.encodePacked("actor", vm.toString(i))));
        }
    }

    function create(uint256 who, uint256 amount) external {
        who = bound(who, 0, ACTORS - 1);
        amount = bound(amount, 1, 10_000e18);
        address a = actors[who];
        (uint256 total,) = env.quote(amount);
        token.mint(a, total);
        vm.startPrank(a);
        token.approve(address(env), total);
        uint256 id = env.create(link, amount, "");
        vm.stopPrank();
        _booked(id, amount);
    }

    function createFor(uint256 who, uint256 amount, bool frontRunPermit) external {
        who = bound(who, 0, ACTORS - 1);
        amount = bound(amount, 1, 10_000e18);
        address a = actors[who];
        (uint256 total,) = env.quote(amount);
        token.mint(a, total);
        EnvelopeV2.CreateForArgs memory args = _args(a, link, amount, block.timestamp + 1 hours, "inv");
        bytes memory auth = _sigCreateFor(env, pks[who], args, env.nonces(a));
        EnvelopeV2.PermitArgs memory p = _permit(token, pks[who], a, address(env), total, block.timestamp + 1 hours);
        if (frontRunPermit) token.permit(a, address(env), total, p.deadline, p.v, p.r, p.s);
        uint256 b = token.balanceOf(relayer);
        vm.prank(relayer);
        uint256 id = env.createFor(args, auth, p);
        uint256 r = token.balanceOf(relayer) - b;
        _booked(id, amount);
        rewardOf[id] += r;
        totalRewards += r;
    }

    function claim(uint256 idx) external {
        if (ids.length == 0) return;
        uint256 id = ids[bound(idx, 0, ids.length - 1)];
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        if (d.status != EnvelopeV2.Status.Open || block.timestamp >= d.expiresAt) return;
        address to = address(uint160(0x1000 + id));
        bytes memory sig = _sigClaim(env, linkPk, id, to);
        uint256 b = token.balanceOf(relayer);
        vm.prank(relayer);
        env.claimFor(id, to, sig);
        uint256 r = token.balanceOf(relayer) - b;
        require(token.balanceOf(to) == d.amount, "recipient must get exact amount");
        rewardOf[id] += r;
        totalRewards += r;
        totalClaimed += d.amount;
    }

    function refund(uint256 idx) external {
        if (ids.length == 0) return;
        uint256 id = ids[bound(idx, 0, ids.length - 1)];
        (EnvelopeV2.Deposit memory d,) = env.getDeposit(id);
        if (d.status != EnvelopeV2.Status.Open) return;
        if (block.timestamp < d.expiresAt) vm.warp(d.expiresAt);
        env.refund(id);
        totalClaimed += d.amount;
    }

    function sweep() external {
        if (env.gasFund() <= env.sweepBuffer()) return;
        totalSwept += env.sweepSurplus();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }

    function _booked(uint256 id, uint256 amount) internal {
        uint256 fee = env.feeFor(amount);
        ids.push(id);
        feeOf[id] = fee;
        totalFees += fee;
        totalOpened += amount;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function sumOpen() external view returns (uint256 s) {
        for (uint256 i; i < ids.length; i++) {
            (EnvelopeV2.Deposit memory d,) = env.getDeposit(ids[i]);
            if (d.status == EnvelopeV2.Status.Open) s += d.amount;
        }
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract EnvelopeV2InvariantTest is Test {
    EnvelopeV2 env;
    MockERC20 token;
    EnvelopeV2Handler handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockERC20("Mezo USD");
        env = new EnvelopeV2(address(token), makeAddr("treasury"), 50, 0.05e18);
        handler = new EnvelopeV2Handler(env, token);
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = EnvelopeV2Handler.create.selector;
        sel[1] = EnvelopeV2Handler.createFor.selector;
        sel[2] = EnvelopeV2Handler.claim.selector;
        sel[3] = EnvelopeV2Handler.refund.selector;
        sel[4] = EnvelopeV2Handler.sweep.selector;
        sel[5] = EnvelopeV2Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// The core accounting rule: every token in the contract belongs either to an open
    /// envelope or to the gas fund, never both, never neither.
    function invariant_BalanceEqualsOpenEnvelopesPlusGasFund() public view {
        assertEq(token.balanceOf(address(env)), handler.sumOpen() + env.gasFund());
    }

    function invariant_EnvelopeMoneyConserved() public view {
        assertEq(handler.sumOpen(), handler.totalOpened() - handler.totalClaimed());
    }

    function invariant_GasFundFlowsAddUp() public view {
        assertEq(env.gasFund(), handler.totalFees() - handler.totalRewards() - handler.totalSwept());
    }

    function invariant_EachEnvelopePaysOutAtMostItsFee() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            uint256 id = handler.ids(i);
            assertLe(handler.rewardOf(id), handler.feeOf(id));
        }
    }

    function invariant_TreasuryOnlyGetsSweeps() public view {
        assertEq(token.balanceOf(env.treasury()), handler.totalSwept());
    }
}
