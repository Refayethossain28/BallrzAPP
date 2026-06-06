// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ApexCoin
 * @notice Native utility token for the ApexVIP platform.
 *
 * Token details
 * -------------
 * Name    : ApexCoin
 * Symbol  : APEX
 * Decimals: 18 (ERC-20 default)
 *
 * Supply model
 * ------------
 * - 1 000 000 000 APEX minted to the deployer at launch (initial treasury).
 * - The owner can mint additional tokens up to MAX_SUPPLY to fund rewards
 *   programs, staking pools, and ecosystem growth.
 * - Any holder can burn their own tokens to reduce circulating supply.
 *
 * Access control
 * --------------
 * - Deployer becomes the owner automatically.
 * - Owner can transfer ownership or renounce it.
 * - Only the owner may mint new tokens.
 */
contract ApexCoin is ERC20, ERC20Burnable, Ownable {
    uint256 public constant MAX_SUPPLY = 10_000_000_000 * 10 ** 18; // 10 billion APEX hard cap
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 10 ** 18; // 1 billion minted at deploy

    event Minted(address indexed to, uint256 amount);

    constructor(address initialOwner)
        ERC20("ApexCoin", "APEX")
        Ownable(initialOwner)
    {
        _mint(initialOwner, INITIAL_SUPPLY);
    }

    /**
     * @notice Mint new APEX tokens. Only callable by the owner.
     * @param to      Recipient address.
     * @param amount  Amount in wei (1 APEX = 1e18).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY, "ApexCoin: max supply exceeded");
        _mint(to, amount);
        emit Minted(to, amount);
    }
}
