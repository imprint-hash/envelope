// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Permit {
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
}

/// @title LinkEscrow
/// @notice Lock MUSD behind a one-time "link key". Whoever holds the link key can
///         authorise a claim to any recipient (EIP-712 signature); a relayer submits it
///         and pays gas. Unclaimed deposits go back to the sender after 7 days.
contract LinkEscrow {
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
        uint96 amount;
    }

    uint256 public constant EXPIRY = 7 days;
    uint256 public constant MAX_NOTE_BYTES = 140;
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,address recipient)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("LinkEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable token;
    uint256 public nextId = 1;
    mapping(uint256 => Deposit) public deposits;
    mapping(uint256 => string) public notes;
    mapping(address => uint256[]) private _bySender;
    uint256 private _lock = 1;

    event Created(
        uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note
    );
    event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sender, uint256 amount);

    error ZeroAmount();
    error AmountTooLarge();
    error ZeroLink();
    error ZeroRecipient();
    error NoteTooLong();
    error NotFound();
    error AlreadyClaimed();
    error AlreadyRefunded();
    error Expired();
    error NotExpired();
    error BadSignature();
    error Reentrancy();
    error TransferFailed();
    error NotAContract();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_) {
        if (token_.code.length == 0) revert NotAContract();
        token = token_;
    }

    // ------------------------------------------------------------------ create

    function create(address link, uint256 amount, string calldata note) external nonReentrant returns (uint256 id) {
        id = _create(link, amount, note);
    }

    function createWithPermit(
        address link,
        uint256 amount,
        string calldata note,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 id) {
        // Empty catch: if someone front-ran the permit, the allowance is already set.
        try IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        id = _create(link, amount, note);
    }

    function _create(address link, uint256 amount, string calldata note) internal returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint96).max) revert AmountTooLarge();
        if (link == address(0)) revert ZeroLink();
        if (bytes(note).length > MAX_NOTE_BYTES) revert NoteTooLong();

        id = nextId++;
        uint64 expiresAt = uint64(block.timestamp + EXPIRY);
        deposits[id] = Deposit({
            sender: msg.sender,
            expiresAt: expiresAt,
            status: Status.Open,
            link: link,
            amount: uint96(amount)
        });
        if (bytes(note).length != 0) notes[id] = note;
        _bySender[msg.sender].push(id);
        emit Created(id, msg.sender, link, amount, expiresAt, note);

        _safeTransferFrom(msg.sender, address(this), amount);
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
        emit Claimed(id, recipient, msg.sender, amount);
        _safeTransfer(recipient, amount);
    }

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

    function _checkOpen(Status st) private pure {
        if (st == Status.None) revert NotFound();
        if (st == Status.Claimed) revert AlreadyClaimed();
        if (st == Status.Refunded) revert AlreadyRefunded();
    }

    // ------------------------------------------------------------------ views

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function claimDigest(uint256 id, address recipient) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient)))
        );
    }

    function getDeposit(uint256 id) external view returns (Deposit memory d, string memory note) {
        d = deposits[id];
        note = notes[id];
    }

    function idsOf(address sender) external view returns (uint256[] memory) {
        return _bySender[sender];
    }

    // ------------------------------------------------------------------ internals

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
