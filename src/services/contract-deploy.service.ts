import { ethers } from "ethers";
import pool from "../pool";
import { logger } from "../logger";
import BearthNFTArtifact from "../contracts/deploy-abi/BearthNFT.json";
import BearthProxyArtifact from "../contracts/deploy-abi/BearthProxy.json";
import ValidatorArtifact from "../contracts/deploy-abi/CreatorTokenTransferValidator.json";

// OpenSea Seaport conduit — pre-whitelisted in the transfer validator so
// listings work immediately after deploy. Mirrors bearth-nft-smartcontract-v1/scripts/deploy.ts.
const OPENSEA_SEAPORT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const LEVEL_2 = 2; // operator whitelist (only approved marketplaces can transfer)
const OPERATOR_WHITELIST = 0;
const MIN_DEPLOY_ETH = "0.05"; // comfortable margin for impl + proxy + validator config

export type DeployNetwork = "sepolia" | "mainnet";

// Signer keys never travel through the browser or an API request body — they
// live only in these server-side env vars, one deployer wallet per network.
// That same wallet's address is used as admin/operations/treasury (matches
// how every deploy has actually been run so far); only the emergency wallet
// must be a separate address, enforced below for mainnet.
function getNetworkConfig(network: DeployNetwork) {
  const prefix = network === "sepolia" ? "DEPLOY_SEPOLIA" : "DEPLOY_MAINNET";
  const rpcUrl = process.env[`${prefix}_RPC_URL`];
  const privateKey = process.env[`${prefix}_PRIVATE_KEY`];
  const emergencyWallet = process.env[`${prefix}_EMERGENCY_WALLET_ADDRESS`];
  if (!rpcUrl) throw new Error(`${prefix}_RPC_URL is not configured on the server.`);
  if (!privateKey) throw new Error(`${prefix}_PRIVATE_KEY is not configured on the server.`);
  if (!emergencyWallet) throw new Error(`${prefix}_EMERGENCY_WALLET_ADDRESS is not configured on the server.`);
  return { rpcUrl, privateKey, emergencyWallet };
}

export async function deployCollectionContract(params: {
  collectionId: string;
  network: DeployNetwork;
  blindBoxUri: string;
  deployedBy: string | null;
}) {
  const { collectionId, network, blindBoxUri, deployedBy } = params;

  const { rows } = await pool.query(
    "SELECT id, name, symbol, contract_address FROM nft_collections WHERE id = $1",
    [collectionId],
  );
  const collection = rows[0];
  if (!collection) throw new Error("Collection not found.");
  if (collection.contract_address) throw new Error("This collection already has a deployed contract.");
  if (!collection.symbol?.trim()) throw new Error("Set a Token Symbol on this collection before deploying a contract.");
  if (!blindBoxUri?.trim()) throw new Error("Blind box metadata URI is required.");

  const { rpcUrl, privateKey, emergencyWallet } = getNetworkConfig(network);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const adminWallet = signer.address;
  const operationsWallet = signer.address;
  const treasury = signer.address;

  if (network === "mainnet" && emergencyWallet.toLowerCase() === operationsWallet.toLowerCase()) {
    throw new Error(
      "Refusing to deploy to mainnet: DEPLOY_MAINNET_EMERGENCY_WALLET_ADDRESS must be a dedicated " +
      "wallet, separate from the deployer wallet. EMERGENCY_ROLE should be an isolated key.",
    );
  }

  const balance = await provider.getBalance(signer.address);
  const minBalance = ethers.parseEther(MIN_DEPLOY_ETH);
  if (balance < minBalance) {
    throw new Error(
      `Deployer wallet balance too low: ${ethers.formatEther(balance)} ETH ` +
      `(need at least ${MIN_DEPLOY_ETH} ETH). Fund ${signer.address} on ${network} and retry.`,
    );
  }

  logger.info(`[contract-deploy] Deploying contract for "${collection.name}" on ${network} — deployer ${signer.address}`);

  // ── 1. Deploy CreatorTokenTransferValidator ──────────────────────────────
  const ValidatorFactory = new ethers.ContractFactory(ValidatorArtifact.abi, ValidatorArtifact.bytecode, signer);
  const validator = await ValidatorFactory.deploy(signer.address);
  await validator.waitForDeployment();
  const validatorAddress = await validator.getAddress();
  logger.info(`[contract-deploy] Validator deployed: ${validatorAddress}`);

  // ── 2. Deploy BearthNFT implementation ───────────────────────────────────
  const BearthNFTFactory = new ethers.ContractFactory(BearthNFTArtifact.abi, BearthNFTArtifact.bytecode, signer);
  const impl = await BearthNFTFactory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  logger.info(`[contract-deploy] Implementation deployed: ${implAddress}`);

  // ── 3. Deploy proxy, calling initialize() in the same transaction ───────
  const initData = BearthNFTFactory.interface.encodeFunctionData("initialize", [
    collection.name,
    collection.symbol,
    blindBoxUri,
    adminWallet,
    operationsWallet,
    emergencyWallet,
    treasury,
    validatorAddress,
  ]);
  const ProxyFactory = new ethers.ContractFactory(BearthProxyArtifact.abi, BearthProxyArtifact.bytecode, signer);
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  const deployTx = proxy.deploymentTransaction();
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  logger.info(`[contract-deploy] Proxy deployed: ${proxyAddress}`);

  // ── 4. Configure transfer validator ──────────────────────────────────────
  const validatorContract = new ethers.Contract(validatorAddress, ValidatorArtifact.abi, signer);
  await (await validatorContract.setTransferSecurityLevelOfCollection(proxyAddress, LEVEL_2)).wait();
  await (await validatorContract.addAccountsToWhitelist(proxyAddress, OPERATOR_WHITELIST, [OPENSEA_SEAPORT])).wait();
  logger.info(`[contract-deploy] Validator configured (LEVEL_2, OpenSea Seaport whitelisted)`);

  await pool.query(
    `UPDATE nft_collections SET
       contract_address = $1, contract_network = $2, contract_validator_address = $3,
       contract_deploy_tx_hash = $4, contract_deployed_at = now(), contract_deployed_by = $5
     WHERE id = $6`,
    [proxyAddress, network, validatorAddress, deployTx?.hash ?? null, deployedBy, collectionId],
  );

  return {
    contractAddress: proxyAddress,
    implementationAddress: implAddress,
    validatorAddress,
    network,
    txHash: deployTx?.hash ?? null,
  };
}
