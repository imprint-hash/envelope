// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {EnvelopeV2} from "../contracts/EnvelopeV2.sol";

interface IMUSD {
    function balanceOf(address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IBorrowerOperations {
    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;
    function minNetDebt() external view returns (uint256);
    function getBorrowingFee(uint256 debt) external view returns (uint256);
}

interface IBorrowerOperationsSignatures {
    function getNonce(address borrower) external view returns (uint256);
    function withdrawMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external;
}

interface ITroveManager {
    function getTroveStatus(address) external view returns (uint256);
    function getTroveDebt(address) external view returns (uint256);
}

/// End to end on a Mezo testnet fork: Bitcoin-backed loan -> gasless envelope -> gasless claim.
/// The borrower never sends a transaction after opening the trove; they only sign.
///
///   forge test --fork-url https://rpc.test.mezo.org --match-path test/EnvelopeV2.fork.t.sol -vv
contract EnvelopeV2ForkTest is Test {
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant BORROWER_OPS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
    address constant BO_SIGS = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address constant ORACLE = 0x7b7c000000000000000000000000000000000015; // Mezo BTC/USD precompile

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant WITHDRAW_TYPEHASH =
        keccak256("WithdrawMUSD(uint256 amount,address borrower,address recipient,uint256 nonce,uint256 deadline)");
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 constant SEND = 100e18; // what the recipient gets; the borrower borrows SEND + 0.5% fee
    uint256 constant REWARD = 0.05e18;

    EnvelopeV2 env;
    address treasury = makeAddr("fork-treasury");
    address relayer = makeAddr("fork-relayer");
    address recipient = makeAddr("fork-recipient");
    address borrower;
    uint256 borrowerPk;
    address link;
    uint256 linkPk;

    function setUp() public {
        if (block.chainid != 31611) {
            vm.skip(true);
            return;
        }
        // Same Mezo Pools wiring as script/DeployV2.s.sol (the constructor checks it against the real router).
        env = new EnvelopeV2(
            MUSD,
            treasury,
            50,
            REWARD,
            EnvelopeV2.PoolsConfig({
                router: 0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9,
                factory: 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A,
                partner: 0xe1a26db653708A2AD8F824E92Db9852410e33A59,
                btc: 0x7b7C000000000000000000000000000000000000,
                earnPool: 0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e,
                btcPool: 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9
            })
        );
        (borrower, borrowerPk) = makeAddrAndKey("fork-borrower");
        (link, linkPk) = makeAddrAndKey("fork-link");
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _withdrawDigest(uint256 amount, uint256 nonce, uint256 dl) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("BorrowerOperationsSignatures"), keccak256("1"), block.chainid, BO_SIGS
            )
        );
        bytes32 structHash = keccak256(abi.encode(WITHDRAW_TYPEHASH, amount, borrower, borrower, nonce, dl));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _permitArgs(uint256 value, uint256 dl) internal view returns (EnvelopeV2.PermitArgs memory p) {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, borrower, address(env), value, IMUSD(MUSD).nonces(borrower), dl));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IMUSD(MUSD).DOMAIN_SEPARATOR(), structHash));
        (p.v, p.r, p.s) = vm.sign(borrowerPk, digest);
        p.deadline = dl;
    }

    // state carried between the steps (keeps each step under the stack limit)
    uint256 total;
    uint256 fee;
    uint256 deadline;
    uint256 musd0;
    bytes mezoSig;
    uint256 id;

    function test_Fork_BorrowFromBitcoinThenGaslessEnvelopeAndClaim() public {
        _step0_openTrove();
        _step1_relayWithdrawMUSD();
        _step2_relayCreateFor();
        _step3_relayClaim();
        _step4_mezoSigNotReplayable();
    }

    /// Mezo's BTC price oracle lives in a chain precompile (0x7b7c..15). Forge's local EVM cannot
    /// execute Mezo precompiles, so we fetch the oracle's REAL answer from the Mezo RPC at the
    /// fork block and serve that exact answer locally. Nothing is invented.
    function _mirrorOraclePrecompile() internal {
        bytes4[2] memory sels = [bytes4(0xfeaf968c), bytes4(0x313ce567)]; // latestRoundData(), decimals()
        for (uint256 i; i < 2; i++) {
            string memory params = string.concat(
                "[{\"to\":\"",
                vm.toString(ORACLE),
                "\",\"data\":\"",
                vm.toString(abi.encodePacked(sels[i])),
                "\"},\"",
                _hexQuantity(block.number),
                "\"]"
            );
            bytes memory live = vm.rpc("eth_call", params);
            vm.mockCall(ORACLE, abi.encodePacked(sels[i]), live);
        }
    }

    function _hexQuantity(uint256 x) internal pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory buf = new bytes(64);
        uint256 n;
        do {
            buf[63 - n] = digits[x & 15];
            x >>= 4;
            n++;
        } while (x != 0);
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; i++) {
            out[i] = buf[64 - n + i];
        }
        return string.concat("0x", string(out));
    }

    /// 0. A fresh borrower opens a trove with BTC (the only tx they ever send).
    function _step0_openTrove() internal {
        _mirrorOraclePrecompile();
        uint256 minDebt = IBorrowerOperations(BORROWER_OPS).minNetDebt();
        vm.deal(borrower, 10 ether);
        vm.prank(borrower);
        IBorrowerOperations(BORROWER_OPS).openTrove{value: 1 ether}(minDebt, address(0), address(0));
        assertEq(ITroveManager(TROVE_MANAGER).getTroveStatus(borrower), 1, "trove active");
        musd0 = IMUSD(MUSD).balanceOf(borrower);
        console2.log("minNetDebt (live)", minDebt);
        console2.log("debt after openTrove", ITroveManager(TROVE_MANAGER).getTroveDebt(borrower));
    }

    /// 1. Borrower SIGNS WithdrawMUSD for envelope + fee (recipient = self); a relayer submits it.
    function _step1_relayWithdrawMUSD() internal {
        (total, fee) = env.quote(SEND);
        deadline = block.timestamp + 30 minutes;
        uint256 debt0 = ITroveManager(TROVE_MANAGER).getTroveDebt(borrower);
        uint256 mezoNonce = IBorrowerOperationsSignatures(BO_SIGS).getNonce(borrower);
        mezoSig = _sign(borrowerPk, _withdrawDigest(total, mezoNonce, deadline));
        uint256 borrowFee = IBorrowerOperations(BORROWER_OPS).getBorrowingFee(total);

        vm.prank(relayer);
        IBorrowerOperationsSignatures(BO_SIGS)
            .withdrawMUSDWithSignature(total, address(0), address(0), borrower, borrower, mezoSig, deadline);

        assertEq(IMUSD(MUSD).balanceOf(borrower), musd0 + total, "borrowed MUSD landed in borrower's own wallet");
        assertEq(
            ITroveManager(TROVE_MANAGER).getTroveDebt(borrower),
            debt0 + total + borrowFee,
            "debt grew by amount + Mezo borrowing fee"
        );
        assertEq(IBorrowerOperationsSignatures(BO_SIGS).getNonce(borrower), mezoNonce + 1);
        console2.log("borrowed (envelope + 0.5% fee)", total);
        console2.log("Mezo borrowing fee", borrowFee);
    }

    /// 2. Borrower SIGNS a MUSD permit (amount + fee) and an Envelope CreateFor; relayer calls createFor.
    function _step2_relayCreateFor() internal {
        EnvelopeV2.CreateForArgs memory a = EnvelopeV2.CreateForArgs({
            sender: borrower, link: link, amount: SEND, deadline: deadline, note: "From my Bitcoin, with love"
        });
        bytes memory authSig = _sign(
            borrowerPk,
            env.createForDigest(borrower, link, SEND, keccak256(bytes(a.note)), env.nonces(borrower), deadline)
        );
        EnvelopeV2.PermitArgs memory p = _permitArgs(total, deadline);

        vm.prank(relayer);
        id = env.createFor(a, authSig, p);

        assertEq(fee, 0.5e18);
        (EnvelopeV2.Deposit memory d, string memory note) = env.getDeposit(id);
        assertEq(d.sender, borrower);
        assertEq(d.link, link);
        assertEq(uint256(d.amount), SEND);
        assertEq(note, "From my Bitcoin, with love");
        assertEq(IMUSD(MUSD).balanceOf(borrower), musd0, "exactly SEND + fee left the borrower");
        assertEq(IMUSD(MUSD).balanceOf(relayer), REWARD, "relayer reward for createFor");
        assertEq(env.gasFund(), fee - REWARD, "fee went to gasFund");
        assertEq(env.nonces(borrower), 1);
        assertEq(borrower.balance, 9 ether, "borrower spent no gas money after openTrove");
    }

    /// 3. The link key SIGNS Claim; relayer calls claimFor to a brand-new recipient.
    function _step3_relayClaim() internal {
        bytes memory claimSig = _sign(linkPk, env.claimDigest(id, recipient));
        vm.prank(relayer);
        env.claimFor(id, recipient, claimSig);

        assertEq(IMUSD(MUSD).balanceOf(recipient), SEND, "recipient got exactly the envelope amount");
        assertEq(IMUSD(MUSD).balanceOf(relayer), 2 * REWARD, "relayer reward for claimFor");
        assertEq(env.gasFund(), fee - 2 * REWARD);
        assertEq(IMUSD(MUSD).balanceOf(address(env)), env.gasFund(), "only the gas fund is left");
    }

    /// 4. The Mezo WithdrawMUSD signature cannot be replayed.
    function _step4_mezoSigNotReplayable() internal {
        vm.prank(relayer);
        vm.expectRevert();
        IBorrowerOperationsSignatures(BO_SIGS)
            .withdrawMUSDWithSignature(total, address(0), address(0), borrower, borrower, mezoSig, deadline);
    }
}
