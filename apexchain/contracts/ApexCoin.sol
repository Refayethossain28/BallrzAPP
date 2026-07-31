// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ApexCoin (AXC) — the ApexVIP loyalty coin as a standard ERC-20.
///
/// Bridge-custodial supply model: the ApexVIP treasury (the contract owner)
/// MINTS tokens only when coins leave the in-app ledger (a withdrawal), and
/// BURNS the tokens it receives back (a deposit). `totalSupply()` therefore
/// always equals the coins circulating OUTSIDE the ApexVIP apps — once
/// withdrawn, AXC is an ordinary ERC-20: hold it in any wallet, send it to
/// anyone, list it anywhere.
///
/// 2 decimals: 1.00 AXC is one in-app APEX, redeemable against £1 of ApexVIP
/// bookings when deposited back. The £ peg is ApexVIP's in-app promise, not a
/// property of this contract.
contract ApexCoin is ERC20, ERC20Burnable, Ownable {
    constructor(address treasury) ERC20("ApexCoin", "AXC") Ownable(treasury) {}

    /// AXC is denominated in hundredths (pence-scale), matching the app ledger.
    function decimals() public pure override returns (uint8) {
        return 2;
    }

    /// Bridge exit: only the treasury mints, and only against a matching
    /// deduction in the app's coin_ledger (enforced by the Cloud Function).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
