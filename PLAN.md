# PLAN.md: MUSD claim links (APPNAME)

I checked these facts against the live chain at about 11:20 WAT:
- **MUSD supports EIP-2612 permit.** `DOMAIN_SEPARATOR()` returns `0x6f9f5c5d...474f`. I recomputed that value myself from `EIP712Domain(name="Mezo USD", version="1", chainId=31611, verifyingContract=MUSD)` and it matches. `eip712Domain()` reports the same values. `nonces(0x..01)` returns 0. The `permit` selector `d505accf` is in the bytecode. `PERMIT_TYPEHASH()` is not exposed (it reverts), so the standard typehash has to be confirmed with a fork test (T-FORK below). Decimals are 18.
- **Opcodes:** PUSH0, TSTORE and MCOPY all run on Mezo testnet, so `evm_version = "cancun"` is safe.
- **Fees and blocks:** base fee is about 130 wei, EIP-1559 works, and blocks come about every 4.2 s.
- **Logs:** `eth_getLogs` is capped at a 10,000-block range (about 11.5 hours). That is why the contract keeps a per-sender id list instead of relying on events.
- **Browser access:** the RPC returns `Access-Control-Allow-Origin: *`, so pages can read the chain directly.
- **forge-std:** version 1.16.2 already exists locally at `/home/imprint/copytrade/lib/forge-std`. Copy it in so nothing needs installing.
- **Tools:** `gh` is logged in as imprint-hash. The `vercel` CLI is installed.

**Two approvals the manager must get from the user now:**
1. `npm install ethers@6.13.4` as the relayer's only server dependency.
2. Vendoring forge-std by copying it (`cp -r /home/imprint/copytrade/lib/forge-std/src lib/forge-std/src` plus its LICENSE files). This is a copy, not a network install.

---

## 1. File tree

```
mezo-link/
  contracts/LinkEscrow.sol
  test/LinkEscrow.t.sol
  test/mocks/MockERC20.sol          # mintable, has permit (for tests)
  test/mocks/ReentrantToken.sol     # calls back into escrow on transfer/transferFrom
  test/mocks/FalseToken.sol         # returns false on transfer (safe-transfer test)
  test/LinkEscrow.fork.t.sol        # T-FORK: real MUSD permit on testnet fork
  script/Deploy.s.sol
  lib/forge-std/src/...             # vendored copy, committed
  public/
    index.html                      # send
    c.html                          # claim (/c via cleanUrls)
    links.html                      # my links
    css/style.css
    js/config.js                    # APPNAME, CHAIN, ESCROW_ADDRESS, MUSD, ABIs
    js/common.js                    # provider, wallet connect/switch, formatters, toasts
    js/send.js  js/claim.js  js/links.js
  api/claim.mjs
  api/health.mjs                    # GET -> {relayer, balanceBtc, escrow} (no secrets)
  foundry.toml  package.json  vercel.json  README.md  .gitignore  .env.example
```

**foundry.toml**
```toml
[profile.default]
src = "contracts"
test = "test"
script = "script"
libs = ["lib"]
solc = "0.8.24"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
remappings = ["forge-std/=lib/forge-std/src/"]
```

**package.json**: `{"name":"mezo-link","private":true,"type":"module","engines":{"node":"22.x"},"dependencies":{"ethers":"6.13.4"}}`

**vercel.json**
```json
{
  "outputDirectory": "public",
  "cleanUrls": true,
  "functions": { "api/claim.mjs": { "maxDuration": 30 } },
  "headers": [{ "source": "/(.*)", "headers": [
    { "key": "Referrer-Policy", "value": "no-referrer" },
    { "key": "X-Content-Type-Options", "value": "nosniff" },
    { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; connect-src 'self' https://rpc.test.mezo.org; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" }
  ]}]
}
```
The CSP `connect-src` rule means injected script cannot send the URL fragment anywhere.

**.gitignore**: `.env`, `node_modules/`, `out/`, `cache/`, `broadcast/`, `.vercel/`

**.env.example**: `RELAYER_PRIVATE_KEY=`, `ESCROW_ADDRESS=`, `RPC_URL=https://rpc.test.mezo.org`

---

## 2. Contract: `contracts/LinkEscrow.sol`

`pragma solidity ^0.8.24;`. No OpenZeppelin.

```solidity
contract LinkEscrow {
    enum Status { None, Open, Claimed, Refunded }
    struct Deposit {            // 2 slots
        address sender;         // slot0: 20
        uint64  expiresAt;      // slot0: 8
        Status  status;         // slot0: 1
        address link;           // slot1: 20
        uint96  amount;         // slot1: 12  (max ~7.9e10 MUSD)
    }

    uint256 public constant EXPIRY = 7 days;
    uint256 public constant MAX_NOTE_BYTES = 140;
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,address recipient)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("LinkEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable token;            // MUSD
    uint256 public nextId = 1;                 // id 0 never exists
    mapping(uint256 => Deposit) public deposits;
    mapping(uint256 => string)  public notes;
    mapping(address => uint256[]) private _bySender;
    uint256 private _lock = 1;                 // 1 = unlocked, 2 = locked

    event Created(uint256 indexed id, address indexed sender, address indexed link, uint256 amount, uint64 expiresAt, string note);
    event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sender, uint256 amount);

    error ZeroAmount(); error AmountTooLarge(); error ZeroLink(); error ZeroRecipient();
    error NoteTooLong(); error NotFound(); error AlreadyClaimed(); error AlreadyRefunded();
    error Expired(); error NotExpired(); error BadSignature(); error Reentrancy();
    error TransferFailed(); error NotAContract();

    constructor(address token_)                       // revert NotAContract if token_.code.length == 0
    function create(address link, uint256 amount, string calldata note) external nonReentrant returns (uint256 id);
    function createWithPermit(address link, uint256 amount, string calldata note,
        uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant returns (uint256 id);
    function claimFor(uint256 id, address recipient, bytes calldata sig) external nonReentrant;
    function refund(uint256 id) external nonReentrant;

    function DOMAIN_SEPARATOR() public view returns (bytes32);   // computed live from block.chainid and address(this)
    function claimDigest(uint256 id, address recipient) public view returns (bytes32);
    function getDeposit(uint256 id) external view returns (Deposit memory d, string memory note);
    function idsOf(address sender) external view returns (uint256[] memory);
}
```

**Semantics. Follow these exactly.**
- **`_create` (internal, shared by both create functions):**
  - Checks, in this order: `amount == 0` reverts ZeroAmount, `amount > type(uint96).max` reverts AmountTooLarge, `link == address(0)` reverts ZeroLink, `bytes(note).length > 140` reverts NoteTooLong.
  - Effects: `id = nextId++`, write the Deposit with status Open and `expiresAt = uint64(block.timestamp + EXPIRY)`, store the note only if it is non-empty, push the id to `_bySender[msg.sender]`, emit Created.
  - Interaction last: `_safeTransferFrom(msg.sender, address(this), amount)`.
- **`createWithPermit`:** `try IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}`, then `_create`. The empty catch defends against a front-run permit: if someone submits the permit first, transferFrom still works on the allowance it set. If no allowance exists, transferFrom fails and the call reverts with TransferFailed.
- **`claimFor`:**
  - Load `d = deposits[id]`.
  - Status checks: None reverts NotFound, Claimed reverts AlreadyClaimed, Refunded reverts AlreadyRefunded.
  - Then: `block.timestamp >= d.expiresAt` reverts Expired, `recipient == 0` reverts ZeroRecipient, `_recover(claimDigest(id, recipient), sig) != d.link` reverts BadSignature.
  - Set status to Claimed, emit `Claimed(id, recipient, msg.sender, amount)`, then `_safeTransfer(recipient, amount)`.
  - Anyone may call it: the relayer, or the recipient themselves.
- **`refund`:** apply the same status checks. `block.timestamp < d.expiresAt` reverts NotExpired. Set status to Refunded, emit Refunded, then `_safeTransfer(d.sender, amount)`. Anyone may call it, but the money always goes to the sender.
- **`claimDigest`:** `keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient))))`.
- **`DOMAIN_SEPARATOR`:** `keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)))`. It is computed every call, never cached, so a chain fork changes it automatically.
- **`_recover(bytes32 h, bytes calldata sig)`:**
  - `if (sig.length != 65) revert BadSignature();`
  - Read r, s, v with assembly: `r := calldataload(sig.offset)`, `s := calldataload(add(sig.offset, 32))`, `v := byte(0, calldataload(add(sig.offset, 64)))`.
  - `if (v < 27) v += 27;` then `if (v != 27 && v != 28) revert BadSignature();` then `if (uint256(s) > HALF_N) revert BadSignature();`
  - `address a = ecrecover(h, v, r, s); if (a == address(0)) revert BadSignature(); return a;`
- **`_safeTransfer` / `_safeTransferFrom`:** `(bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb /*transfer*/ or 0x23b872dd /*transferFrom*/, ...)); if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();`
- **`nonReentrant`:** `if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1;`
- **Minimal interface at the top of the file:** `interface IERC20Permit { function permit(address,address,uint256,uint256,uint8,bytes32,bytes32) external; }`

**The exact typed data the link key signs** (browser side, ethers v6):
```js
domain = { name: "LinkEscrow", version: "1", chainId: 31611, verifyingContract: ESCROW_ADDRESS }
types  = { Claim: [ { name: "id", type: "uint256" }, { name: "recipient", type: "address" } ] }
value  = { id: BigInt(id), recipient }
sig    = await new ethers.Wallet("0x" + linkPk).signTypedData(domain, types, value)   // 65 bytes, v = 27 or 28
```
The domain name stays "LinkEscrow" even after the product is renamed, so a rename never breaks signatures.

**The MUSD Permit the sender signs** (via MetaMask `signer.signTypedData`):
```js
domain = { name: "Mezo USD", version: "1", chainId: 31611, verifyingContract: MUSD }
types  = { Permit: [ {name:"owner",type:"address"}, {name:"spender",type:"address"}, {name:"value",type:"uint256"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint256"} ] }
value  = { owner, spender: ESCROW_ADDRESS, value: amount, nonce: await musd.nonces(owner), deadline: now + 1800 }
```
Then split with `ethers.Signature.from(sig)` to get `{v, r, s}`.

**Create path in the frontend:**
1. If `allowance(owner, escrow) >= amount`, call `create`.
2. Otherwise try permit, then `createWithPermit`.
3. If the user rejects the permit signature (error code 4001), stop and show "You cancelled. Nothing was sent."
4. If permit signing fails for any other reason, fall back to `approve(escrow, amount)`, wait for it, then call `create`.

---

## 3. Foundry tests (`test/LinkEscrow.t.sol`)

Setup: deploy MockERC20 with permit. `sender` gets 1,000e18 minted and approves the escrow. Make the link key with `(link, linkPk) = makeAddrAndKey("link")`. A helper `_sign(pk, id, recipient)` uses `vm.sign(pk, escrow.claimDigest(id, recipient))` and returns `abi.encodePacked(r, s, v)`.

Every one of these must pass:
1. `test_Create_StoresDepositAndPullsFunds`: checks the struct fields, expiresAt = now + 7 days, the note, `idsOf(sender)`, and both balances.
2. `test_Create_EmitsCreated` (`vm.expectEmit`)
3. `test_CreateWithPermit_SingleTx` (no prior approve)
4. `test_CreateWithPermit_FrontrunPermitStillWorks`: someone else submits the permit first and the call still succeeds.
5. `test_RevertWhen_ZeroAmount`
6. `test_RevertWhen_ZeroLink`
7. `test_RevertWhen_AmountTooLarge`
8. `test_RevertWhen_NoteTooLong` (141 bytes)
9. `test_RevertWhen_NoAllowance` (TransferFailed)
10. `test_Claim_HappyPath`: called by a relayer address. The recipient gets the amount, the relayer's balance does not change, and the status is Claimed.
11. `test_Claim_EmitsClaimed` (with the relayer = msg.sender)
12. `test_RevertWhen_DoubleClaim` (AlreadyClaimed)
13. `test_RevertWhen_ClaimAfterRefund` (AlreadyRefunded)
14. `test_RevertWhen_ClaimAfterExpiry` (Expired, after `vm.warp(expiresAt)`)
15. `test_RevertWhen_ClaimNonexistent` (NotFound, for id 0 and id 999)
16. `test_RevertWhen_WrongSigner` (a random key signs)
17. `test_RevertWhen_SigForOtherRecipient`: the relayer swaps the recipient to itself.
18. `test_RevertWhen_SigReplayedOnOtherId`: two deposits share the same link address, and the sig for id 1 is used on id 2.
19. `test_RevertWhen_SigForOtherChain`: sign the digest under `vm.chainId(1)`, then switch back, or the reverse.
20. `test_RevertWhen_SigForOtherContract`: deploy a second escrow and use the first contract's sig on it.
21. `test_RevertWhen_MalleableHighS`: flip s to n - s and v to 27/28 the other way.
22. `test_RevertWhen_BadSigLength` (64 and 66 bytes)
23. `test_RevertWhen_InvalidV` (v = 29)
24. `test_RevertWhen_ZeroRecipient`
25. `test_Refund_AfterExpiry`: anyone can call it, the money goes to the sender, and Refunded is emitted.
26. `test_RevertWhen_RefundBeforeExpiry` (NotExpired at expiresAt - 1)
27. `test_RevertWhen_RefundAfterClaim` (AlreadyClaimed)
28. `test_RevertWhen_DoubleRefund` (AlreadyRefunded)
29. `test_Reentrancy_OnClaim`: ReentrantToken's `transfer` tries to call `escrow.claimFor` / `refund` again. The outer call must revert, either because Reentrancy bubbles up or because the token turns the failed reentry into a revert. Either way the escrow balance is unchanged and the status is still Open.
30. `test_Reentrancy_OnCreate`: same idea, with the callback in `transferFrom`.
31. `test_RevertWhen_TokenReturnsFalse` (FalseToken leads to TransferFailed)
32. `test_DomainSeparator_MatchesManual` and `test_ClaimDigest_MatchesEthersFormat`: hardcode one digest computed off-chain with ethers to prove the browser and the contract agree. The coder generates it with `node -e` against ethers' `TypedDataEncoder.hash`.
33. `testFuzz_ClaimOnlyByLinkKey(uint256 pk, address recipient)`: bound pk, and assume the key's address is not the link.

**T-FORK (`LinkEscrow.fork.t.sol`)**, run with `forge test --fork-url https://rpc.test.mezo.org --match-contract Fork`. Deploy the escrow pointing at the real MUSD. A fresh `makeAddrAndKey` owner signs a permit with vm.sign using the standard Permit typehash. Call `MUSD.permit` and assert the allowance equals the value. This proves the permit path end to end before any UI work depends on it.

---

## 4. Relayer: `api/claim.mjs`

**Decision: ethers 6.13.4 as a server dependency.** It needs approval. Raw JSON-RPC signing needs keccak, RLP and secp256k1 recovery IDs, none of which Node's crypto provides, so it is not worth the risk today.

Module scope, reused while the instance stays warm: `provider = new JsonRpcProvider(RPC_URL, 31611, { staticNetwork: true })`, `wallet = new Wallet(RELAYER_PRIVATE_KEY, provider)`, `escrow = new Contract(ESCROW_ADDRESS, ABI, wallet)`, and maps `ipHits` and `inFlight` (a Set of ids). Never log the request body or the key. Only log `{id, recipient, txHash}` or the error code.

**Order of handling** (return as soon as one check fails). Every response is JSON `{ ok, error?, code?, txHash?, explorerUrl? }`:
1. Allow only `POST`, otherwise 405. If the body is over 2 KB, return 413.
2. **Rate limit:**
   - Take the IP from the first entry of `x-forwarded-for`.
   - Sliding window: at most 5 requests per 60 s per IP, and at most 60 per 60 s across the whole instance. Over the limit returns 429 "Too many tries. Please wait a minute and try again."
   - This limit is per instance, so it is best-effort. The real protection is steps 4 to 6: the relayer never broadcasts anything that would revert, so junk requests cost no gas.
3. **Input shape:** `id` must be a string or number matching `/^\d{1,12}$/`. `recipient` must pass `ethers.isAddress`, then normalise it with `getAddress`. `signature` must match `/^0x[0-9a-fA-F]{130}$/`. Any failure returns 400 "This link looks incomplete. Please open it again from the original message."
4. If `inFlight.has(id)`, return 409 "This claim is already on its way. Give it a few seconds." Otherwise add it, and remove it in `finally`.
5. **On-chain prechecks:**
   - Read `d = await escrow.getDeposit(id)`.
   - Status None returns 404, Claimed 409, Refunded 410.
   - Fetch the latest block. If `block.timestamp >= expiresAt`, return 410 Expired.
6. **Signature precheck:** `ethers.verifyTypedData(domain, types, {id, recipient}, signature)` must equal `d.link`, otherwise 400 BadSignature. Also reject a high s (check `Signature.from(sig).s`) so behaviour matches the contract.
7. **Simulate:** `await escrow.claimFor.staticCall(id, recipient, signature)`. On revert, decode the custom error with `escrow.interface.parseError(e.data)` and map it with the table below.
8. **Gas tank:** if `provider.getBalance(wallet.address) < parseEther("0.0005")`, return 503 "Our network-fee wallet is empty right now. Please try again later."
9. **Send:**
   - `gas = await escrow.claimFor.estimateGas(...)`, then `gasLimit = gas * 13n / 10n`. If gasLimit is over 250,000, refuse with 500.
   - Fees come from ethers' `getFeeData()` automatically (EIP-1559).
   - `tx = await escrow.claimFor(id, recipient, signature, { gasLimit })`.
   - If the error message contains "nonce" or "underpriced", retry once.
   - Return 200 `{ ok: true, txHash: tx.hash, explorerUrl: "https://explorer.test.mezo.org/tx/" + tx.hash }` as soon as the tx is broadcast. Do not wait for mining. The browser waits with `provider.waitForTransaction(hash, 1, 60000)`, which keeps the function well under the timeout.
10. Anything unexpected returns 500 "Something went wrong on our side. Your money is safe in the link. Please try again in a minute."

**Error messages** (the same table lives in `public/js/common.js` for the UI):
| code | message |
|---|---|
| NotFound | "We couldn't find this link. Make sure you copied the whole thing." |
| AlreadyClaimed | "This money has already been claimed." |
| AlreadyRefunded | "This link expired and the money went back to the sender." |
| Expired | "This link has expired. The sender can take the money back. Ask them to send a new one." |
| BadSignature | "This link looks damaged. Ask the sender to share it again." |
| ZeroRecipient | "We couldn't set up your wallet. Please refresh and try again." |

`api/health.mjs` (GET) returns `{ relayer: wallet.address, balance: formatEther(...), escrow }`. It never includes the key.

---

## 5. Frontend

All pages load ethers from `https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js` with an `integrity="sha384-..."` attribute. Compute the hash with `curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A`.

`config.js` holds: `APPNAME = "APPNAME"`, `CHAIN = { id: 31611, hex: "0x7b7b", rpc, explorer }`, `ESCROW_ADDRESS`, `MUSD`, and the minimal ABIs. All reads go through `new ethers.JsonRpcProvider(CHAIN.rpc)`. MetaMask is used only for the sender's writes.

Layout is a single column, max-width 480 px, with 48 px-tall tap targets, large amount type, and system fonts. Copy is warm and plain. Every error ends with what to do next.

**Wallet helper (`common.js`):**
- `connect()` calls `eth_requestAccounts`.
- `ensureChain()` calls `wallet_switchEthereumChain` with `{chainId: "0x7b7b"}`. On error 4902 it calls `wallet_addEthereumChain` with:
  - `chainName: "Mezo Testnet"`
  - `nativeCurrency: {name: "Bitcoin", symbol: "BTC", decimals: 18}`
  - `rpcUrls: ["https://rpc.test.mezo.org"]`
  - `blockExplorerUrls: ["https://explorer.test.mezo.org"]`
- Listen for `chainChanged` and `accountsChanged` and re-render when they fire.

### index.html: Send
States, in order:
- **No wallet extension:** "To send money you need a browser wallet like MetaMask. Receiving doesn't need one." Show a MetaMask link.
- **Not connected:** "Send dollars to anyone with just a link." Button: [Connect wallet].
- **Wrong network:** "Let's switch you to Mezo Testnet." Button: [Switch network].
- **Ready:** show the MUSD balance ("You have 120.00 MUSD"), an amount input (decimal, with a quick "Max" option), a note input (up to 140 characters, with the hint "Notes are public on the blockchain"), and the [Send] button.
- **Insufficient MUSD:** "You only have X MUSD. Get test MUSD at testnet.mezo.org." Disable the button.
- **No BTC for gas** (balance is 0): "You need a little test BTC for the network fee. Get some free at faucet.test.mezo.org."
- **Signing permit:** "Please confirm in your wallet. This lets APPNAME move exactly 50 MUSD."
- **Approving (fallback):** "Step 1 of 2: approving..." then "Step 2 of 2: sending..."
- **Sending:** "Locking your 50 MUSD into a link..." with a spinner. Wait for the receipt, then get the id by parsing the `Created` log from the receipt.
- **Done:**
  - Heading: "Your link is ready."
  - The link sits in a read-only box with [Copy link], [Share on WhatsApp] and [Send another] buttons.
  - The WhatsApp button opens `https://wa.me/?text=` + `encodeURIComponent("I've sent you $50 with APPNAME" + (note ? ` for "${note}"` : "") + ". Tap to claim it, no app or fees needed: " + url)`.
  - Warning: "Anyone with this link can claim the money. Only share it with the person you're paying. If it isn't claimed in 7 days, you can take it back."
- **Errors:** user rejected: "You cancelled. Nothing was sent." Anything else: "That didn't go through. Your money hasn't moved. Please try again."

**Key handling:**
- Generate the link key with `ethers.Wallet.createRandom()` before the tx is sent.
- Build the URL as `${location.origin}/c#${id}.${pk.slice(2)}` once the id is known.
- Save `{id, url, amount, note, createdAt}` to `localStorage["appname.sentLinks.v1"]` under the sender's address. Save the key as `pendingKey` before sending, so a crash between the tx and the receipt does not lose it, and clear `pendingKey` once the link is saved.

### c.html: Claim
- **Parse:** read `location.hash.slice(1)` and match `/^(\d+)\.([0-9a-fA-F]{64})$/`. If it does not match: "This link looks incomplete. Please open it again from the original message."
- **Loading:** "Opening your money..." while reading `getDeposit(id)` and the latest block timestamp.
- **States from the deposit:**
  - Not found: NotFound copy.
  - Claimed: "This money has already been claimed." If it was claimed to this phone's wallet, show "It's in your wallet" and the balance.
  - Refunded or expired: "This link has expired and the money went back to the sender."
  - Also check that `new Wallet(pk).address == d.link`. If not, use the BadSignature copy.
- **Ready:** a big amount ("$50.00", noting MUSD = digital dollars), the note in quotes, "Expires in 6 days", then a primary button [Claim my $50] and a secondary link "I already have a wallet (MetaMask)".
- **Recipient wallet:**
  - The default is an in-browser wallet in `localStorage["appname.wallet.v1"] = { address, mnemonic }`, created with `Wallet.createRandom()` the first time the recipient claims. Reuse it if it already exists.
  - With MetaMask, the recipient comes from `eth_requestAccounts`. No network switch is needed because the link key signs, not MetaMask.
- **Claiming:** "Claiming... this takes a few seconds." Sign with the link key, POST to `/api/claim`, then wait for the receipt on the public RPC.
- **Done:**
  - Heading: "$50 is yours." Link: "View on explorer". Show the wallet balance by reading `MUSD.balanceOf`.
  - Then call `history.replaceState(null, "", "/c#" + id)` so the key is removed from the address bar and history.
  - A non-blocking card: "Keep this money safe: save your recovery phrase." Button: [Show my recovery phrase].
- **Export:** the [Show my recovery phrase] button shows a confirm screen: "Anyone who sees these 12 words can take your money. Write them down somewhere private." It then shows the mnemonic and a [Copy private key] button (for importing into MetaMask). The same "My wallet" section appears whenever a local wallet exists.
- **Errors:** show the relayer's `error` text verbatim, plus a [Try again] button. On a network failure: "We couldn't reach the network. Check your connection and try again."

### links.html: My links
- **Connect and switch states:** same as Send.
- **Data:** read `idsOf(account)`, then `getDeposit` for each id in parallel, plus the latest block timestamp.
- **Each row shows:** amount, note, created and expiry dates, and a status chip:
  - "Waiting": status Open and not yet expired. Offer [Copy link] or [Share] if the URL is in localStorage.
  - "Claimed".
  - "Refunded".
  - "Ready to take back": Open and expired. Button: [Take my money back], which calls `refund(id)`, then "Done. $50 is back in your wallet."
- **Empty state:** "You haven't sent any links yet." with a button to Send.
- **Old links:** for links made on another device the URL is not stored, so show "Link saved on another device".

Navigation footer on every page: Send · My links · (on the claim page) My wallet.

---

## 6. Deploy steps

1. **Relayer key, never printed:**
   ```
   ~/.foundry/bin/cast wallet new --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s)[0];require("fs").writeFileSync(".env",`RELAYER_PRIVATE_KEY=${w.private_key}\nRPC_URL=https://rpc.test.mezo.org\nESCROW_ADDRESS=\n`,{mode:0o600});console.log(w.address)})'
   ```
   The user then funds that address with test BTC at faucet.test.mezo.org (captcha). **The user must also get test MUSD on their MetaMask account now**: faucet BTC, then borrow MUSD at testnet.mezo.org.
2. **Tests:** `forge build && forge test -vv`, then the T-FORK run.
3. **Deploy:** `script/Deploy.s.sol`:
   ```
   vm.startBroadcast(vm.envUint("RELAYER_PRIVATE_KEY"));
   new LinkEscrow(0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503);
   ```
   Run it with `set -a; . ./.env; set +a; forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast`. If the EIP-1559 tx errors, add `--legacy`.
   - Put the deployed address in `.env` as ESCROW_ADDRESS and in `public/js/config.js`. The address is public, so committing it is fine.
   - Optional: verify with `forge verify-contract <addr> contracts/LinkEscrow.sol:LinkEscrow --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api/ --constructor-args $(cast abi-encode "c(address)" 0x1189...)`. Skip it if it fails.
4. **Smoke test with cast:**
   - `cast call $ESCROW "DOMAIN_SEPARATOR()(bytes32)"`.
   - Check that `claimDigest(1, addr)` matches the ethers `TypedDataEncoder.hash` for the deployed address.
5. **GitHub:** `git init` (a `.git` exists already), commit without any AI attribution, then `gh repo create imprint-hash/mezo-link --public --source . --push`.
6. **Vercel:**
   - Import the repo, or run `vercel link`.
   - Add env vars without echoing them: `vercel env add RELAYER_PRIVATE_KEY production`, entered from `.env` through a pipe such as `grep ^RELAYER_PRIVATE_KEY= .env | cut -d= -f2 | vercel env add RELAYER_PRIVATE_KEY production`. Do the same for ESCROW_ADDRESS and RPC_URL.
   - Run `vercel --prod`.
   - Check that `/api/health` shows the relayer address and its balance.
7. **Real end-to-end test:**
   - Send 5 MUSD from desktop MetaMask.
   - Open the link on a phone through WhatsApp.
   - Claim to a new in-browser wallet.
   - Confirm the tx on the explorer and the balance on the page.
   - Try opening the link again: it should say "already claimed".
   - Put the tx hashes in the README.

---

## 7. Timeline (WAT) and risks

| Time | Work |
|---|---|
| 11:30–11:45 | Get approvals (ethers, forge-std copy). Generate the relayer key. The user starts the faucet and MUSD borrow right away. Scaffold the repo. |
| 11:45–12:30 | Contract and mocks. Tests 1–33 green, plus T-FORK. |
| 12:30–12:45 | Deploy to testnet, cast smoke test, put the address in config. |
| 12:45–13:15 | `api/claim.mjs` and `health.mjs`. Test locally with `vercel dev` using a cast-made sig. |
| 13:15–14:15 | `common.js`, Send, Claim, Links pages and CSS (Claim first, since it's the demo). |
| 14:15–14:35 | Push to GitHub, Vercel prod, env vars, real end-to-end test on a phone. |
| 14:35–14:55 | Bug fixes, README (what it is, how it works, security model, addresses, tx links, Wave 2 plan), screenshots. |
| 15:00 | Code freeze. |

**Top 5 risks:**
1. **No test MUSD or BTC when it's time to demo.** The faucet and borrowing need the user's captcha. Mitigation: the user does it at 11:30, in parallel, and funds both the sender account and the relayer.
2. **ethers server dependency not approved, or the Vercel build fails.** Mitigation: ask now. Pin 6.13.4 and set `"type":"module"`. Test `vercel dev` before 13:15. If it is denied, the fallback is that the claim page lets a MetaMask user call `claimFor` directly and pay their own gas. That is less ideal but the contract already allows it.
3. **Signature mismatch between the browser and the contract** (domain name, chainId as a number, address checksum). Mitigation: test 32 pins one ethers-computed digest, and step 6.4 compares on the deployed contract.
4. **Serverless issues: timeouts or nonce collisions.** Mitigation: return right after broadcast, use maxDuration 30, retry once on nonce errors, and use the in-flight id lock. Blocks every 4 s keep confirmations fast.
5. **Mobile WhatsApp in-app browser quirks**: localStorage wiped, clipboard blocked, or the fragment dropped. Mitigation: test on a real phone by 14:30. Make copy buttons fall back to selecting the text. The claim does not depend on stored state beforehand, and the fragment is only removed after success. Add a line in the UI: "Tip: open in Chrome or Safari to keep your wallet."

Smaller watch items: the CSP blocking cdnjs (the SRI hash has to match exactly), and `cleanUrls` routing `/c`. Check `/c#1.abc` on the preview deploy.

### Critical Files for Implementation
- /home/imprint/mezo-link/contracts/LinkEscrow.sol
- /home/imprint/mezo-link/test/LinkEscrow.t.sol
- /home/imprint/mezo-link/api/claim.mjs
- /home/imprint/mezo-link/public/js/claim.js
- /home/imprint/mezo-link/public/js/send.js