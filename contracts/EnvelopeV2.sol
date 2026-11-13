// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
    function allowance(address, address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @title EnvelopeV2
/// @notice Lock MUSD behind a one-time "link key". Whoever holds the link key can
///         authorise a claim to any recipient (EIP-712 signature); a relayer submits it.
///         Unclaimed envelopes go back to the sender after 7 days.
///
///         New in V2:
///         - The sender pays a 0.5% fee on top; the recipient gets exactly the envelope amount.
///           The fee goes into `gasFund`, which pays relayers a small reward per relayed call,
///           so the service pays its own gas. Anything above a buffer can be swept, by anyone,
///           but only ever to the fixed `treasury`.
///         - `createFor`: the sender signs (no gas) and a relayer creates the envelope from the
///           sender's own wallet. Together with Mezo's `withdrawMUSDWithSignature`, a borrower
///           can send money from their Bitcoin loan with three signatures and zero gas.
///
///         Money in envelopes and money in `gasFund` are tracked separately at all times:
///         token.balanceOf(this) == sum(open envelope amounts) + gasFund.
///         No owner, no admin keys, nothing upgradeable.
contract EnvelopeV2 {
    enum Status {
        None,
        Open,
        Claimed,
        Refunded
    }

    struct Deposit {
        address sender;
        uint64 expiresAt;
        Status status;
        address link;
        uint96 amount; // what the recipient gets (the fee was paid on top)
    }

    /// @dev What the sender signs for `createFor`. `note` is checked against the signed noteHash.
    struct CreateForArgs {
        address sender;
        address link;
        uint256 amount; // envelope amount; the sender pays amount + feeFor(amount)
        uint256 deadline; // deadline of the CreateFor signature
        string note;
    }

    /// @dev EIP-2612 permit for amount + fee, owner = sender, spender = this contract.
    struct PermitArgs {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    uint256 public constant EXPIRY = 7 days;
    uint256 public constant MAX_NOTE_BYTES = 140;
    uint256 public constant MAX_FEE_BPS = 100; // 1% hard cap
    uint256 public constant MAX_RELAYER_REWARD = 1e18; // 1 MUSD hard cap
    uint256 public constant BUFFER_REWARDS = 100; // sweep keeps 100 relayer rewards in the fund

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,address recipient)");
    bytes32 public constant CREATE_FOR_TYPEHASH = keccak256(
        "CreateFor(address sender,address link,uint256 amount,bytes32 noteHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Envelope");
    bytes32 private constant VERSION_HASH = keccak256("2");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable token;
    address public immutable treasury;
    uint256 public immutable FEE_BPS;
    uint256 public immutable relayerReward;
    uint256 public immutable sweepBuffer;

    uint256 public nextId = 1;
    uint256 public gasFund;
    mapping(uint256 => Deposit) public deposits;
    mapping(uint256 => string) public notes;
    mapping(address => uint256) public nonces;
    mapping(address => uint256[]) private _bySender;
    uint256 private _lock = 1;

    event Created(
        uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note
    );
    event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sender, uint256 amount);
    event FeeTaken(uint256 indexed id, uint256 fee);
    event RelayerPaid(address indexed relayer, uint256 amount);
    event Swept(uint256 amount);

    error ZeroAmount();
    error AmountTooLarge();
    error ZeroLink();
    error ZeroRecipient();
    error ZeroAddress();
    error NoteTooLong();
    error NotFound();
    error AlreadyClaimed();
    error AlreadyRefunded();
    error Expired();
    error NotExpired();
    error BadSignature();
    error SignatureExpired();
    error PermitFailed();
    error Reentrancy();
    error TransferFailed();
    error WrongAmountReceived();
    error NotAContract();
    error FeeTooHigh();
    error RewardTooHigh();
    error NothingToSweep();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_, address treasury_, uint256 feeBps_, uint256 relayerReward_) {
        if (token_.code.length == 0) revert NotAContract();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (relayerReward_ > MAX_RELAYER_REWARD) revert RewardTooHigh();
        token = token_;
        treasury = treasury_;
        FEE_BPS = feeBps_;
        relayerReward = relayerReward_;
        sweepBuffer = relayerReward_ * BUFFER_REWARDS;
    }

    // ------------------------------------------------------------------ create

    /// @notice Lock `amount` for the link holder. Pulls amount + feeFor(amount) from msg.sender.
    function create(address link, uint256 amount, string calldata note) external nonReentrant returns (uint256 id) {
        uint256 total;
        (id, total,) = _record(msg.sender, link, amount, note);
        _pull(msg.sender, total);
    }

    /// @notice Same as `create`, with an EIP-2612 permit for amount + fee in the same tx.
    function createWithPermit(
        address link,
        uint256 amount,
        string calldata note,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 id) {
        (uint256 total,) = quote(amount);
        _permit(msg.sender, total, PermitArgs(deadline, v, r, s));
        (id,,) = _record(msg.sender, link, amount, note);
        _pull(msg.sender, total);
    }

    /// @notice Create an envelope for `a.sender`, who signed a CreateFor message and an
    ///         EIP-2612 permit for amount + fee. The caller (a relayer) pays gas and earns a
    ///         reward from `gasFund`.
    function createFor(CreateForArgs calldata a, bytes calldata authSig, PermitArgs calldata p)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (block.timestamp > a.deadline) revert SignatureExpired();
        if (a.sender == address(0)) revert ZeroAddress();
        uint256 nonce = nonces[a.sender];
        bytes32 digest = createForDigest(a.sender, a.link, a.amount, keccak256(bytes(a.note)), nonce, a.deadline);
        if (_recover(digest, authSig) != a.sender) revert BadSignature();
        nonces[a.sender] = nonce + 1;

        (uint256 total, uint256 fee) = quote(a.amount);
        _permit(a.sender, total, p);
        (id,,) = _record(a.sender, a.link, a.amount, a.note);
        // Each envelope pays out at most the fee it paid in: half here, half on claimFor.
        uint256 reward = _takeReward(fee / 2);
        _pull(a.sender, total);
        _payRelayer(reward);
    }

    /// @dev Effects only: validates, stores the envelope and books the fee into gasFund.
    function _record(address from, address link, uint256 amount, string calldata note)
        private
        returns (uint256 id, uint256 total, uint256 fee)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint96).max) revert AmountTooLarge();
        if (link == address(0)) revert ZeroLink();
        if (bytes(note).length > MAX_NOTE_BYTES) revert NoteTooLong();
        (total, fee) = quote(amount);
        if (total > type(uint96).max) revert AmountTooLarge(); // amount + fee must fit too

        id = nextId++;
        uint64 expiresAt = uint64(block.timestamp + EXPIRY);
        deposits[id] =
            Deposit({sender: from, expiresAt: expiresAt, status: Status.Open, link: link, amount: uint96(amount)});
        if (bytes(note).length != 0) notes[id] = note;
        _bySender[from].push(id);
        gasFund += fee;
        emit Created(id, from, link, amount, expiresAt, note);
        if (fee != 0) emit FeeTaken(id, fee);
    }

    /// @dev Pull exactly `total`; a token that delivers less would break the accounting.
    function _pull(address from, uint256 total) private {
        uint256 before = IERC20Like(token).balanceOf(address(this));
        _safeTransferFrom(from, address(this), total);
        if (IERC20Like(token).balanceOf(address(this)) - before != total) revert WrongAmountReceived();
    }

    // ------------------------------------------------------------------ claim / refund

    function claimFor(uint256 id, address recipient, bytes calldata sig) external nonReentrant {
        Deposit storage d = deposits[id];
        _checkOpen(d.status);
        if (block.timestamp >= d.expiresAt) revert Expired();
        if (recipient == address(0) || recipient == address(this) || recipient == token) revert ZeroRecipient();
        if (_recover(claimDigest(id, recipient), sig) != d.link) revert BadSignature();

        d.status = Status.Claimed;
        uint256 amount = d.amount;
        // The other half of this envelope's fee (recomputed exactly from the stored amount).
        uint256 reward = _takeReward(feeFor(amount) / 2);
        emit Claimed(id, recipient, msg.sender, amount);
        _safeTransfer(recipient, amount);
        _payRelayer(reward);
    }

    /// @notice After expiry anyone may trigger the refund; money always goes to the sender.
    ///         The fee is not returned (it already paid for gas).
    function refund(uint256 id) external nonReentrant {
        Deposit storage d = deposits[id];
        _checkOpen(d.status);
        if (block.timestamp < d.expiresAt) revert NotExpired();

        d.status = Status.Refunded;
        uint256 amount = d.amount;
        address sender = d.sender;
        emit Refunded(id, sender, amount);
        _safeTransfer(sender, amount);
    }

    // ------------------------------------------------------------------ gas fund

    /// @notice Move everything above `sweepBuffer` from `gasFund` to `treasury`. Anyone may call.
    function sweepSurplus() external nonReentrant returns (uint256 amount) {
        uint256 fund = gasFund;
        if (fund <= sweepBuffer) revert NothingToSweep();
        amount = fund - sweepBuffer;
        gasFund = sweepBuffer;
        emit Swept(amount);
        _safeTransfer(treasury, amount);
    }

    /// @dev Effects only: books min(relayerReward, cap, gasFund) out of gasFund.
    ///      The reward can only ever come out of gasFund, never out of envelope money.
    function _takeReward(uint256 cap) private returns (uint256 reward) {
        reward = relayerReward;
        if (cap < reward) reward = cap;
        uint256 fund = gasFund;
        if (fund < reward) reward = fund;
        if (reward != 0) gasFund = fund - reward;
    }

    function _payRelayer(uint256 reward) private {
        if (reward == 0) return;
        emit RelayerPaid(msg.sender, reward);
        _safeTransfer(msg.sender, reward);
    }

    // ------------------------------------------------------------------ views

    /// @notice Fee the sender pays on top of `amount`. Rounded up, so the fund never under-collects.
    function feeFor(uint256 amount) public view returns (uint256) {
        return (amount * FEE_BPS + 9_999) / 10_000;
    }

    /// @return total what the sender pays (and what the permit must cover)
    /// @return fee what goes into gasFund
    function quote(uint256 amount) public view returns (uint256 total, uint256 fee) {
        fee = feeFor(amount);
        total = amount + fee;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function claimDigest(uint256 id, address recipient) public view returns (bytes32) {
        return _hashTyped(keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient)));
    }

    function createForDigest(
        address sender,
        address link,
        uint256 amount,
        bytes32 noteHash,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTyped(keccak256(abi.encode(CREATE_FOR_TYPEHASH, sender, link, amount, noteHash, nonce, deadline)));
    }

    function getDeposit(uint256 id) external view returns (Deposit memory d, string memory note) {
        d = deposits[id];
        note = notes[id];
    }

    function idsOf(address sender) external view returns (uint256[] memory) {
        return _bySender[sender];
    }

    // ------------------------------------------------------------------ internals

    function _checkOpen(Status st) private pure {
        if (st == Status.None) revert NotFound();
        if (st == Status.Claimed) revert AlreadyClaimed();
        if (st == Status.Refunded) revert AlreadyRefunded();
    }

    function _hashTyped(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev If someone front-ran the permit (or it was never needed), carry on when the
    ///      allowance already covers `value`.
    function _permit(address owner, uint256 value, PermitArgs memory p) private {
        try IERC20Like(token).permit(owner, address(this), value, p.deadline, p.v, p.r, p.s) {}
        catch {
            if (IERC20Like(token).allowance(owner, address(this)) < value) revert PermitFailed();
        }
    }

    function _recover(bytes32 h, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > HALF_N) revert BadSignature();
        address a = ecrecover(h, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
