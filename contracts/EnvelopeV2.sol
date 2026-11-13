// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
    function allowance(address, address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Mezo Pools router (Velodrome/Aerodrome-style), testnet 0x9a1f…E7E9. Signatures checked
///      against the verified ABI on the Mezo explorer.
interface IPoolsRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    /// @return ratio share of tokenA (1e18 = 100%) to swap into tokenB before adding liquidity
    function quoteStableLiquidityRatio(address tokenA, address tokenB, address factory)
        external
        view
        returns (uint256 ratio);

    function poolFor(address tokenA, address tokenB, bool stable, address factory) external view returns (address);
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
///
///         Mezo Pools claim options (`claimWithOption`, also signed by the link key, also gasless):
///         - EARN: the envelope becomes a MUSD/stable Mezo Pools liquidity position owned by the
///           recipient (it earns trading fees and can be withdrawn any time).
///         - GAS_TIP: a small slice (min(1 MUSD, 5%)) is swapped to BTC so the recipient has gas;
///           the rest arrives as MUSD.
///         Either way the whole envelope leaves in one transaction or nothing happens.
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

    /// @dev Mezo Pools wiring, fixed at deploy. All zero = claim options switched off.
    struct PoolsConfig {
        address router; // Mezo Pools Router
        address factory; // Mezo PoolFactory (used in swap routes)
        address partner; // stable partner of MUSD for EARN (mUSDC)
        address btc; // BTC token on Mezo (same balance as native BTC)
        address earnPool; // MUSD/partner stable pool (its LP token is the recipient's position)
        address btcPool; // MUSD/BTC volatile pool
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
    uint8 public constant MODE_EARN = 1;
    uint8 public constant MODE_GAS_TIP = 2;
    uint256 public constant GAS_TIP_MAX = 1e18; // at most 1 MUSD becomes BTC
    uint256 public constant GAS_TIP_BPS = 500; // ...and at most 5% of the envelope

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,address recipient)");
    bytes32 public constant CLAIM_WITH_OPTION_TYPEHASH =
        keccak256("ClaimWithOption(uint256 id,address recipient,uint8 mode,uint256 minOut,uint256 deadline)");
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

    address public immutable router;
    address public immutable factory;
    address public immutable partner;
    address public immutable btc;
    address public immutable earnPool;
    address public immutable btcPool;

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
    /// @param musdSent MUSD paid straight to the recipient (EARN: unused dust; GAS_TIP: amount - tip)
    /// @param out EARN: LP tokens of `earnPool` minted to the recipient; GAS_TIP: BTC received
    event ClaimedWithOption(uint256 indexed id, address indexed recipient, uint8 mode, uint256 musdSent, uint256 out);

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
    error PoolsDisabled();
    error BadMode();
    error AmountTooSmall();
    error InsufficientOutput();
    error BadPoolsConfig();
    error RouterMisbehaved();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_, address treasury_, uint256 feeBps_, uint256 relayerReward_, PoolsConfig memory pools_) {
        if (token_.code.length == 0) revert NotAContract();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (relayerReward_ > MAX_RELAYER_REWARD) revert RewardTooHigh();
        token = token_;
        treasury = treasury_;
        FEE_BPS = feeBps_;
        relayerReward = relayerReward_;
        sweepBuffer = relayerReward_ * BUFFER_REWARDS;
        _checkPools(token_, pools_);
        router = pools_.router;
        factory = pools_.factory;
        partner = pools_.partner;
        btc = pools_.btc;
        earnPool = pools_.earnPool;
        btcPool = pools_.btcPool;
    }

    /// @dev Either everything is zero (options off) or every address is a contract and the
    ///      router itself confirms both pools.
    function _checkPools(address token_, PoolsConfig memory p) private view {
        if (
            p.router == address(0) && p.factory == address(0) && p.partner == address(0) && p.btc == address(0)
                && p.earnPool == address(0) && p.btcPool == address(0)
        ) return;
        if (
            p.router.code.length == 0 || p.factory.code.length == 0 || p.partner.code.length == 0
                || p.btc.code.length == 0 || p.earnPool.code.length == 0 || p.btcPool.code.length == 0
        ) revert BadPoolsConfig();
        if (p.partner == token_ || p.btc == token_ || p.partner == p.btc) revert BadPoolsConfig();
        if (IPoolsRouter(p.router).poolFor(token_, p.partner, true, p.factory) != p.earnPool) revert BadPoolsConfig();
        if (IPoolsRouter(p.router).poolFor(token_, p.btc, false, p.factory) != p.btcPool) revert BadPoolsConfig();
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

    /// @notice Claim into a Mezo Pools option instead of plain MUSD. Signed by the link key over
    ///         ClaimWithOption(id, recipient, mode, minOut, deadline); any relayer may submit.
    ///         If the pools can't deliver `minOut` the whole call reverts and the envelope stays
    ///         Open, so a plain `claimFor` still works.
    /// @param mode MODE_EARN (minOut = min LP tokens) or MODE_GAS_TIP (minOut = min BTC)
    function claimWithOption(
        uint256 id,
        address recipient,
        uint8 mode,
        uint256 minOut,
        uint256 deadline,
        bytes calldata sig
    ) external nonReentrant {
        if (router == address(0)) revert PoolsDisabled();
        if (mode != MODE_EARN && mode != MODE_GAS_TIP) revert BadMode();
        if (block.timestamp > deadline) revert SignatureExpired();
        Deposit storage d = deposits[id];
        _checkOpen(d.status);
        if (block.timestamp >= d.expiresAt) revert Expired();
        if (
            recipient == address(0) || recipient == address(this) || recipient == token || recipient == router
                || recipient == partner || recipient == btc || recipient == earnPool || recipient == btcPool
        ) revert ZeroRecipient();
        if (_recover(claimWithOptionDigest(id, recipient, mode, minOut, deadline), sig) != d.link) {
            revert BadSignature();
        }

        // Effects first: the envelope is spent and the reward booked before any external call.
        d.status = Status.Claimed;
        uint256 amount = d.amount;
        uint256 reward = _takeReward(feeFor(amount) / 2);
        emit Claimed(id, recipient, msg.sender, amount);

        // Every other token here (other envelopes, gasFund incl. the booked reward) must still be
        // here afterwards; only this envelope's `amount` may leave.
        uint256 floor = IERC20Like(token).balanceOf(address(this)) - amount;
        (uint256 musdSent, uint256 out) = mode == MODE_EARN
            ? _earn(recipient, amount, minOut, deadline, floor)
            : _gasTip(recipient, amount, minOut, deadline, floor);
        emit ClaimedWithOption(id, recipient, mode, musdSent, out);
        _payRelayer(reward);
    }

    /// @dev Swap the right share of MUSD to the stable partner, add both as liquidity with the
    ///      LP tokens minted straight to the recipient, then hand back any unused dust.
    function _earn(address recipient, uint256 amount, uint256 minLp, uint256 deadline, uint256 floor)
        private
        returns (uint256 musdSent, uint256 lp)
    {
        // The pool may be unbalanced, so "half" would leave a lot unused. The router's own
        // ratio says how much MUSD to swap so both sides fit the pool.
        uint256 swapIn = amount * IPoolsRouter(router).quoteStableLiquidityRatio(token, partner, factory) / 1e18;
        if (swapIn == 0 || swapIn >= amount) revert AmountTooSmall();

        uint256 partnerBefore = IERC20Like(partner).balanceOf(address(this));
        _swap(swapIn, 0, partner, true, address(this), deadline);
        uint256 got = IERC20Like(partner).balanceOf(address(this)) - partnerBefore;
        if (got == 0) revert InsufficientOutput();

        lp = _addLiquidity(recipient, amount - swapIn, got, deadline);
        if (lp < minLp || lp == 0) revert InsufficientOutput();

        musdSent = _musdLeft(floor);
        if (musdSent != 0) _safeTransfer(recipient, musdSent);
        uint256 partnerLeft = IERC20Like(partner).balanceOf(address(this)) - partnerBefore;
        if (partnerLeft != 0) _safeTransferOf(partner, recipient, partnerLeft);
    }

    /// @dev addLiquidity with exact approvals (reset to 0 after); LP is minted to the recipient.
    function _addLiquidity(address recipient, uint256 musdIn, uint256 partnerIn, uint256 deadline)
        private
        returns (uint256 lp)
    {
        uint256 lpBefore = IERC20Like(earnPool).balanceOf(recipient);
        _safeApprove(token, router, musdIn);
        _safeApprove(partner, router, partnerIn);
        IPoolsRouter(router).addLiquidity(token, partner, true, musdIn, partnerIn, 0, 0, recipient, deadline);
        _safeApprove(token, router, 0);
        _safeApprove(partner, router, 0);
        lp = IERC20Like(earnPool).balanceOf(recipient) - lpBefore;
    }

    /// @dev Swap min(1 MUSD, 5%) to BTC for the recipient, send the rest as MUSD.
    function _gasTip(address recipient, uint256 amount, uint256 minBtc, uint256 deadline, uint256 floor)
        private
        returns (uint256 musdSent, uint256 btcOut)
    {
        uint256 tip = gasTipFor(amount);
        if (tip == 0) revert AmountTooSmall();
        uint256 btcBefore = IERC20Like(btc).balanceOf(recipient);
        _swap(tip, minBtc, btc, false, recipient, deadline);
        btcOut = IERC20Like(btc).balanceOf(recipient) - btcBefore;
        if (btcOut < minBtc || btcOut == 0) revert InsufficientOutput();
        musdSent = _musdLeft(floor);
        if (musdSent != 0) _safeTransfer(recipient, musdSent);
    }

    /// @dev One-hop swap of MUSD with an exact approval that is reset to 0 afterwards.
    function _swap(uint256 amountIn, uint256 minOut, address to, bool stable, address dest, uint256 deadline) private {
        IPoolsRouter.Route[] memory r = new IPoolsRouter.Route[](1);
        r[0] = IPoolsRouter.Route({from: token, to: to, stable: stable, factory: factory});
        _safeApprove(token, router, amountIn);
        IPoolsRouter(router).swapExactTokensForTokens(amountIn, minOut, r, dest, deadline);
        _safeApprove(token, router, 0);
    }

    /// @dev MUSD of this envelope still held here. Reverts if the router took anything that
    ///      wasn't this envelope's (impossible with exact approvals; checked anyway).
    function _musdLeft(uint256 floor) private view returns (uint256) {
        uint256 bal = IERC20Like(token).balanceOf(address(this));
        if (bal < floor) revert RouterMisbehaved();
        return bal - floor;
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

    /// @notice MUSD that GAS_TIP turns into BTC: min(1 MUSD, 5% of the envelope).
    function gasTipFor(uint256 amount) public pure returns (uint256 tip) {
        tip = amount * GAS_TIP_BPS / 10_000;
        if (tip > GAS_TIP_MAX) tip = GAS_TIP_MAX;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function claimDigest(uint256 id, address recipient) public view returns (bytes32) {
        return _hashTyped(keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient)));
    }

    function claimWithOptionDigest(uint256 id, address recipient, uint8 mode, uint256 minOut, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTyped(keccak256(abi.encode(CLAIM_WITH_OPTION_TYPEHASH, id, recipient, mode, minOut, deadline)));
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
        _safeTransferOf(token, to, amount);
    }

    function _safeTransferOf(address t, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address t, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
