// SPDX-License-Identifier: MIT
pragma solidity 0.7.5;

/**
 * @title MockUniswapV2Pair
 * @dev Minimal Uniswap V2 LP pair mock for testing.
 *      Implements the interface required by StandardBondingCalculator:
 *      token0(), token1(), getReserves(), totalSupply(), decimals()
 *      plus a mintable ERC20 for the LP token itself.
 */
contract MockUniswapV2Pair {
    string public constant name = "Mock LP Token";
    string public constant symbol = "MOCK-LP";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public token0;
    address public token1;

    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address _token0, address _token1) {
        require(_token0 != address(0) && _token1 != address(0), "MockLP: zero address");
        token0 = _token0;
        token1 = _token1;
    }

    // ── IUniswapV2Pair ───────────────────────────────────────────────────────

    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        )
    {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    // ── Test helpers ─────────────────────────────────────────────────────────

    function setReserves(uint112 reserve0, uint112 reserve1) external {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = uint32(block.timestamp);
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    // ── ERC20 ────────────────────────────────────────────────────────────────

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MockLP: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != uint256(-1)) {
            require(allowance[from][msg.sender] >= amount, "MockLP: insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }
        require(balanceOf[from] >= amount, "MockLP: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
