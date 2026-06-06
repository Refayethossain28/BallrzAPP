const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ApexCoin", function () {
  let apexCoin;
  let owner;
  let user1;
  let user2;

  const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // 1 billion
  const MAX_SUPPLY = ethers.parseEther("10000000000");    // 10 billion

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();
    const ApexCoin = await ethers.getContractFactory("ApexCoin");
    apexCoin = await ApexCoin.deploy(owner.address);
    await apexCoin.waitForDeployment();
  });

  describe("Deployment", function () {
    it("has correct name and symbol", async function () {
      expect(await apexCoin.name()).to.equal("ApexCoin");
      expect(await apexCoin.symbol()).to.equal("APEX");
    });

    it("mints initial supply to owner", async function () {
      expect(await apexCoin.totalSupply()).to.equal(INITIAL_SUPPLY);
      expect(await apexCoin.balanceOf(owner.address)).to.equal(INITIAL_SUPPLY);
    });

    it("has correct max supply constant", async function () {
      expect(await apexCoin.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
    });
  });

  describe("Minting", function () {
    it("allows owner to mint tokens", async function () {
      const mintAmount = ethers.parseEther("1000");
      await apexCoin.mint(user1.address, mintAmount);
      expect(await apexCoin.balanceOf(user1.address)).to.equal(mintAmount);
    });

    it("emits Minted event on mint", async function () {
      const mintAmount = ethers.parseEther("500");
      await expect(apexCoin.mint(user1.address, mintAmount))
        .to.emit(apexCoin, "Minted")
        .withArgs(user1.address, mintAmount);
    });

    it("reverts if non-owner tries to mint", async function () {
      await expect(
        apexCoin.connect(user1).mint(user1.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(apexCoin, "OwnableUnauthorizedAccount");
    });

    it("reverts when mint would exceed max supply", async function () {
      const overMint = MAX_SUPPLY - INITIAL_SUPPLY + ethers.parseEther("1");
      await expect(
        apexCoin.mint(user1.address, overMint)
      ).to.be.revertedWith("ApexCoin: max supply exceeded");
    });
  });

  describe("Transfers", function () {
    it("allows token transfers between accounts", async function () {
      const amount = ethers.parseEther("100");
      await apexCoin.transfer(user1.address, amount);
      expect(await apexCoin.balanceOf(user1.address)).to.equal(amount);
    });

    it("supports approve and transferFrom", async function () {
      const amount = ethers.parseEther("50");
      await apexCoin.approve(user1.address, amount);
      await apexCoin.connect(user1).transferFrom(owner.address, user2.address, amount);
      expect(await apexCoin.balanceOf(user2.address)).to.equal(amount);
    });
  });

  describe("Burning", function () {
    it("allows token holders to burn their tokens", async function () {
      const burnAmount = ethers.parseEther("1000");
      const supplyBefore = await apexCoin.totalSupply();
      await apexCoin.burn(burnAmount);
      expect(await apexCoin.totalSupply()).to.equal(supplyBefore - burnAmount);
    });
  });

  describe("Ownership", function () {
    it("sets deployer as owner", async function () {
      expect(await apexCoin.owner()).to.equal(owner.address);
    });

    it("allows owner to transfer ownership", async function () {
      await apexCoin.transferOwnership(user1.address);
      expect(await apexCoin.owner()).to.equal(user1.address);
    });
  });
});
