// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";
import {IPoolsRouter} from "../../contracts/EnvelopeV2.sol";

/// @notice LP token of a mock Mezo pool (tests only).
contract MockPool is MockERC20 {
    address public token0;
    address public token1;
    bool public stable;

    constructor(address a, address b, bool s) MockERC20("Mock LP") {
        (token0, token1) = a < b ? (a, b) : (b, a);
        stable = s;
    }
}

/// @notice Stand-in for the Mezo Pools Router (Velodrome-style signatures, tests only).
///         Swaps pull the input and mint the output at a fixed rate. addLiquidity uses a fixed
///         pool ratio, pulls what fits, and mints LP. Knobs let tests make it misbehave.
contract MockPoolsRouter {
    mapping(bytes32 => address) internal _pools;
    mapping(address => mapping(address => uint256[2])) public rate; // out = in * num / den
    mapping(address => mapping(address => uint256[2])) public lpRatio; // amountB = amountA * num / den
    uint256 public ratio = 0.3e18; // quoteStableLiquidityRatio
    uint256 public takeLess; // swap pulls amountIn - takeLess (leaves an allowance behind)
    uint256 public lpHaircutBps; // simulates a manipulated pool: fewer LP tokens
    bool public broken; // every call reverts
    address public reenterTarget;
    bytes internal _reenterData;

    function _key(address a, address b, bool s) internal pure returns (bytes32) {
        (address x, address y) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(x, y, s));
    }

    function setPool(address a, address b, bool s, address pool) external {
        _pools[_key(a, b, s)] = pool;
    }

    function setRate(address from, address to, uint256 num, uint256 den) external {
        rate[from][to] = [num, den];
    }

    function setLpRatio(address a, address b, uint256 num, uint256 den) external {
        lpRatio[a][b] = [num, den];
    }

    function setRatio(uint256 r) external {
        ratio = r;
    }

    function setTakeLess(uint256 x) external {
        takeLess = x;
    }

    function setLpHaircut(uint256 bps) external {
        lpHaircutBps = bps;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function arm(address target, bytes calldata data) external {
        reenterTarget = target;
        _reenterData = data;
    }

    function poolFor(address a, address b, bool s, address) external view returns (address) {
        return _pools[_key(a, b, s)];
    }

    function quoteStableLiquidityRatio(address, address, address) external view returns (uint256) {
        return ratio;
    }

    function getAmountsOut(uint256 amountIn, IPoolsRouter.Route[] calldata routes)
        public
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        uint256[2] memory r = rate[routes[0].from][routes[0].to];
        amounts[1] = amountIn * r[0] / r[1];
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IPoolsRouter.Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(!broken, "BROKEN");
        require(block.timestamp <= deadline, "Expired");
        _maybeReenter();
        amounts = getAmountsOut(amountIn, routes);
        require(amounts[1] >= amountOutMin, "InsufficientOutputAmount");
        MockERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn - takeLess);
        MockERC20(routes[0].to).mint(to, amounts[1]);
    }

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
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(!broken, "BROKEN");
        require(block.timestamp <= deadline, "Expired");
        (amountA, amountB) = _fit(tokenA, tokenB, amountADesired, amountBDesired);
        require(amountA >= amountAMin && amountB >= amountBMin, "InsufficientAmount");
        liquidity = _mintLp(tokenA, tokenB, stable, amountA, amountB, to);
    }

    function _fit(address tokenA, address tokenB, uint256 aDes, uint256 bDes)
        internal
        view
        returns (uint256 a, uint256 b)
    {
        uint256[2] memory k = lpRatio[tokenA][tokenB];
        uint256 bOpt = aDes * k[0] / k[1];
        if (bOpt <= bDes) (a, b) = (aDes, bOpt);
        else (a, b) = (bDes * k[1] / k[0], bDes);
    }

    function _mintLp(address tokenA, address tokenB, bool stable, uint256 a, uint256 b, address to)
        internal
        returns (uint256 liquidity)
    {
        address pool = _pools[_key(tokenA, tokenB, stable)];
        MockERC20(tokenA).transferFrom(msg.sender, pool, a);
        MockERC20(tokenB).transferFrom(msg.sender, pool, b);
        liquidity = (a + b) * (10_000 - lpHaircutBps) / 10_000;
        MockPool(pool).mint(to, liquidity);
    }

    function _maybeReenter() internal {
        if (reenterTarget == address(0)) return;
        (bool ok, bytes memory ret) = reenterTarget.call(_reenterData);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @notice Empty contract standing in for the PoolFactory address (only used inside routes).
contract MockFactory {}
