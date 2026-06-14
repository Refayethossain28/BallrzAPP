const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying ApexCoin with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const ApexCoin = await ethers.getContractFactory("ApexCoin");
  const apexCoin = await ApexCoin.deploy(deployer.address);

  await apexCoin.waitForDeployment();

  const address = await apexCoin.getAddress();
  console.log("\n✅ ApexCoin deployed!");
  console.log("   Contract address :", address);
  console.log("   Token name        :", await apexCoin.name());
  console.log("   Token symbol      :", await apexCoin.symbol());
  console.log("   Total supply      :", ethers.formatEther(await apexCoin.totalSupply()), "APEX");
  console.log("   Max supply        :", ethers.formatEther(await apexCoin.MAX_SUPPLY()), "APEX");
  console.log("\nSave this contract address in your .env file as APEX_CONTRACT_ADDRESS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
