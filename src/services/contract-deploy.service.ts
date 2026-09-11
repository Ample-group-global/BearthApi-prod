import { ethers } from "ethers";
import pool from "../pool";
import { logger } from "../logger";
import BearthNFTArtifact from "../contracts/deploy-abi/BearthNFT.json";
import BearthProxyArtifact from "../contracts/deploy-abi/BearthProxy.json";
import ValidatorArtifact from "../contracts/deploy-abi/CreatorTokenTransferValidator.json";
import RevealCoordinatorArtifact from "../contracts/deploy-abi/BearthRevealCoordinator.json";
import { invalidateCollectionContractCache, attachListenersForCollection } from "./contract.service";

// Chainlink VRF v2.5 addresses -- mirrors scripts/deployRevealCoordinator.ts
// in bearth-nft-smartcontract-v1 (single source of truth for these constants
// would ideally live in one place; kept in sync manually for now).
const VRF_COORDINATOR: Record<DeployNetwork, string> = {
  sepolia: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
  mainnet: "0xD7f86b4b8Cae7D942340FF628F82735b7a20893a",
};
const VRF_KEY_HASH: Record<DeployNetwork, string> = {
  sepolia: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
  mainnet: "0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9",
};

// OpenSea Seaport conduit — pre-whitelisted in the transfer validator so
// listings work immediately after deploy. Mirrors bearth-nft-smartcontract-v1/scripts/deploy.ts.
const OPENSEA_SEAPORT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const LEVEL_2 = 2; // operator whitelist (only approved marketplaces can transfer)
const OPERATOR_WHITELIST = 0;
const MIN_DEPLOY_ETH = "0.05"; // comfortable margin for impl + proxy + validator config

export type DeployNetwork = "sepolia" | "mainnet";

// Fibonacci split across the 7 fixed waves (multipliers 1,1,2,3,5,8,13, sum
// 33) -- the same formula BearthNFT.sol's original hardcoded 9999-collection
// wave sizes (303/303/606/909/1515/2424/3939) always followed, since
// 9999/33 = 303. Computed here (off-chain, in this trusted admin-only deploy
// path) rather than on-chain because BearthNFT.sol has ~0 bytecode headroom
// under EIP-170's 24KB limit; initialize() just validates+sums whatever's
// passed in, so there's no way for MAX_SUPPLY to disagree with the real wave
// allocations regardless of how this array was computed.
const WAVE_FIB = [1, 1, 2, 3, 5, 8, 13];
const WAVE_FIB_SUM = 33;
function fibonacciWaveQtys(totalSupply: number): number[] {
  const qtys = WAVE_FIB.map((f) => Math.floor((totalSupply * f) / WAVE_FIB_SUM));
  const remainder = totalSupply - qtys.reduce((a, b) => a + b, 0);
  qtys[6] += remainder; // any rounding remainder goes to the largest (final) wave
  return qtys;
}

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
  const adminGovernanceWallet = process.env[`${prefix}_ADMIN_GOVERNANCE_WALLET_ADDRESS`];
  if (!rpcUrl) throw new Error(`${prefix}_RPC_URL is not configured on the server.`);
  if (!privateKey) throw new Error(`${prefix}_PRIVATE_KEY is not configured on the server.`);
  if (!emergencyWallet) throw new Error(`${prefix}_EMERGENCY_WALLET_ADDRESS is not configured on the server.`);
  if (!adminGovernanceWallet) throw new Error(`${prefix}_ADMIN_GOVERNANCE_WALLET_ADDRESS is not configured on the server.`);
  return { rpcUrl, privateKey, emergencyWallet, adminGovernanceWallet };
}

export async function deployCollectionContract(params: {
  collectionId: string;
  network: DeployNetwork;
  blindBoxUri: string;
  deployedBy: string | null;
}) {
  const { collectionId, network, blindBoxUri, deployedBy } = params;

  const { rows } = await pool.query(
    "SELECT id, name, symbol, supply, contract_address FROM nft_collections WHERE id = $1",
    [collectionId],
  );
  const collection = rows[0];
  if (!collection) throw new Error("Collection not found.");
  if (collection.contract_address) throw new Error("This collection already has a deployed contract.");
  if (!collection.symbol?.trim()) throw new Error("Set a Token Symbol on this collection before deploying a contract.");
  if (!blindBoxUri?.trim()) throw new Error("Blind box metadata URI is required.");
  const totalSupply = Number(collection.supply);
  // < 33 (the Fibonacci multiplier sum) would floor the smallest wave(s) to 0,
  // which initialize() rejects (InvalidQuantity) -- every wave must get >= 1.
  if (!Number.isInteger(totalSupply) || totalSupply < 33) {
    throw new Error("Collection supply must be a whole number of at least 33 before deploying a contract (so every wave gets at least 1 token).");
  }
  const waveQtys = fibonacciWaveQtys(totalSupply);

  const { rpcUrl, privateKey, emergencyWallet, adminGovernanceWallet } = getNetworkConfig(network);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const adminWallet = signer.address;
  const treasury = signer.address;
  // operationsWallet is deliberately NOT signer.address: BearthApi-V1's
  // day-to-day write operations (setWaveSchedule, treasuryClose, revealWave,
  // pause, etc. -- everything in nft-sell/waves.ts) sign with
  // CONTRACT_PRIVATE_KEY/FIXED_PRIVATE_KEY, a DIFFERENT wallet from this
  // deploy-time signer. Granting OPERATOR_ROLE to the deployer instead of
  // this wallet left every freshly-deployed collection-wise contract
  // unusable by the actual backend signer (confirmed 2026-09-10: "Caller
  // does not have the required role" on setWaveSchedule for Bearth Test1).
  const operationsPrivateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
  if (!operationsPrivateKey) {
    throw new Error("CONTRACT_PRIVATE_KEY (or FIXED_PRIVATE_KEY) is not configured on the server -- required so the deployed contract's OPERATOR_ROLE matches the wallet BearthApi-V1 actually signs wave-management transactions with.");
  }
  const operationsWallet = new ethers.Wallet(operationsPrivateKey).address;

  if (network === "mainnet" && emergencyWallet.toLowerCase() === operationsWallet.toLowerCase()) {
    throw new Error(
      "Refusing to deploy to mainnet: DEPLOY_MAINNET_EMERGENCY_WALLET_ADDRESS must be a dedicated " +
      "wallet, separate from the deployer wallet. EMERGENCY_ROLE should be an isolated key.",
    );
  }
  if (network === "mainnet" && adminGovernanceWallet.toLowerCase() === signer.address.toLowerCase()) {
    throw new Error(
      "Refusing to deploy to mainnet: DEPLOY_MAINNET_ADMIN_GOVERNANCE_WALLET_ADDRESS must be a dedicated " +
      "wallet, separate from the deployer wallet. UPGRADER_ROLE/TREASURY_TIMELOCK_ROLE should not sit on the " +
      "same key used for routine deploys.",
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

  logger.info(`[contract-deploy] Deploying contract for "${collection.name}" on ${network} — deployer ${signer.address}, supply ${totalSupply}, waves ${JSON.stringify(waveQtys)}`);

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
    waveQtys,
  ]);
  const ProxyFactory = new ethers.ContractFactory(BearthProxyArtifact.abi, BearthProxyArtifact.bytecode, signer);
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  const deployTx = proxy.deploymentTransaction();
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  logger.info(`[contract-deploy] Proxy deployed: ${proxyAddress}`);

  // ── 3b. Grant REVEAL_ROLE to the operations wallet ───────────────────────
  // initialize() only grants OPERATOR_ROLE to operationsWallet -- reveal.service.ts
  // signs revealWave() directly from this same wallet (no separate VRF
  // coordinator contract exists yet), so it also needs REVEAL_ROLE or every
  // reveal reverts with AccessControlUnauthorizedAccount.
  const proxyContract = new ethers.Contract(proxyAddress, BearthNFTArtifact.abi, signer);
  const revealRole = await proxyContract.REVEAL_ROLE();
  await (await proxyContract.grantRole(revealRole, operationsWallet)).wait();
  logger.info(`[contract-deploy] REVEAL_ROLE granted to operations wallet ${operationsWallet}`);

  // ── 4. Configure transfer validator ──────────────────────────────────────
  const validatorContract = new ethers.Contract(validatorAddress, ValidatorArtifact.abi, signer);
  await (await validatorContract.setTransferSecurityLevelOfCollection(proxyAddress, LEVEL_2)).wait();
  await (await validatorContract.addAccountsToWhitelist(proxyAddress, OPERATOR_WHITELIST, [OPENSEA_SEAPORT])).wait();
  logger.info(`[contract-deploy] Validator configured (LEVEL_2, OpenSea Seaport whitelisted)`);

  // ── 5. Deploy + wire BearthRevealCoordinator (Chainlink VRF v2.5) ───────
  // Without this, revealWave() hard-reverts forever on mainnet (WaveRandomnessNotSet
  // -- see BearthNFT.sol's block.chainid == 1 guard). Deployed on every network,
  // not just mainnet, so testnet exercises the exact same reveal path production
  // will use, instead of the weaker block.prevrandao fallback diverging from it.
  logger.info(`[contract-deploy] Deploying BearthRevealCoordinator (VRF)...`);
  const vrfCoordinatorAddr = VRF_COORDINATOR[network];
  const vrfKeyHash = VRF_KEY_HASH[network];
  const vrfSubscriptionEnv = process.env[`VRF_SUBSCRIPTION_ID_${network.toUpperCase()}`];
  const vrfSubscriptionId = vrfSubscriptionEnv ? BigInt(vrfSubscriptionEnv) : 0n;
  if (network === "mainnet" && vrfSubscriptionId === 0n) {
    throw new Error(
      `Refusing to deploy to mainnet: VRF_SUBSCRIPTION_ID_MAINNET is not set. ` +
      `requestReveal() would revert forever until a funded Chainlink VRF subscription exists -- ` +
      `create one at https://vrf.chain.link first.`,
    );
  }
  if (vrfSubscriptionId === 0n) {
    logger.warn(`[contract-deploy] VRF_SUBSCRIPTION_ID_${network.toUpperCase()} not set -- coordinator will deploy but requestReveal() will revert until a subscription is created and coordinator.setSubscriptionId() is called.`);
  }
  const CoordinatorFactory = new ethers.ContractFactory(RevealCoordinatorArtifact.abi, RevealCoordinatorArtifact.bytecode, signer);
  const coordinator = await CoordinatorFactory.deploy(
    vrfCoordinatorAddr, proxyAddress, adminWallet, operationsWallet, vrfSubscriptionId, vrfKeyHash,
  );
  await coordinator.waitForDeployment();
  const coordinatorAddress = await coordinator.getAddress();
  logger.info(`[contract-deploy] RevealCoordinator deployed: ${coordinatorAddress}`);

  const coordinatorRevealRole = await proxyContract.REVEAL_ROLE();
  await (await proxyContract.grantRole(coordinatorRevealRole, coordinatorAddress)).wait();
  await (await proxyContract.setRevealCoordinator(coordinatorAddress)).wait();
  logger.info(`[contract-deploy] Coordinator wired: REVEAL_ROLE granted + setRevealCoordinator() called`);

  // ── 5b. Propose coordinator ownership transfer away from the deploy wallet ──
  // VRFConsumerBaseV2Plus inherits Chainlink's ConfirmedOwner, which makes
  // the DEPLOYING wallet the coordinator's owner() -- completely separate
  // from this project's AccessControl roles. That owner can call
  // setCoordinator(attackerContract) and have it call rawFulfillRandomWords()
  // with an arbitrary value, fully rigging the reveal shuffle (found 2026-09-11).
  // transferOwnership() only PROPOSES the new owner -- acceptOwnership() must
  // still be called by adminGovernanceWallet itself (its private key is never
  // held by this server, by design -- see the 5-wallet separation-of-duties
  // model). Until that acceptance happens, the deploy wallet remains the real
  // owner and this vulnerability is NOT closed -- just queued.
  await (await coordinator.transferOwnership(adminGovernanceWallet)).wait();
  logger.warn(`[contract-deploy] Coordinator ownership transfer PROPOSED to ${adminGovernanceWallet} -- ` +
    `still owned by the deploy wallet until that wallet calls acceptOwnership() on ${coordinatorAddress} directly (e.g. via Etherscan). ` +
    (network === "mainnet" ? "REQUIRED before mainnet reveal is safe." : "Recommended before treating this deploy as production-representative."));

  // ── 6. Grant governance-only roles to the Admin/Governance wallet ───────
  // initialize() never grants UPGRADER_ROLE or TREASURY_TIMELOCK_ROLE to
  // anyone (confirmed by reading BearthNFT.sol directly) -- left unassigned,
  // NOBODY (including the team) can upgrade the contract or change the
  // treasury wallet. Wired here to the dedicated Admin/Governance wallet so
  // deployer/operations keys can't exercise these, but a real Bearth-team
  // key still can.
  const upgraderRole = await proxyContract.UPGRADER_ROLE();
  const treasuryTimelockRole = await proxyContract.TREASURY_TIMELOCK_ROLE();
  await (await proxyContract.grantRole(upgraderRole, adminGovernanceWallet)).wait();
  await (await proxyContract.grantRole(treasuryTimelockRole, adminGovernanceWallet)).wait();
  logger.info(`[contract-deploy] UPGRADER_ROLE + TREASURY_TIMELOCK_ROLE granted to Admin/Governance wallet ${adminGovernanceWallet}`);

  await pool.query(
    `UPDATE nft_collections SET
       contract_address = $1, contract_network = $2, contract_validator_address = $3,
       contract_deploy_tx_hash = $4, contract_deployed_at = now(), contract_deployed_by = $5,
       contract_reveal_coordinator_address = $7, contract_vrf_subscription_id = $8
     WHERE id = $6`,
    [proxyAddress, network, validatorAddress, deployTx?.hash ?? null, deployedBy, collectionId,
     coordinatorAddress, vrfSubscriptionId > 0n ? vrfSubscriptionId.toString() : null],
  );

  // This function refuses to run if contract_address is already set -- but a
  // reset flow that nulls contract_address first (as used repeatedly this
  // session for redeploy-and-retest cycles) then calls this again for the
  // SAME collectionId, which is exactly how the stale-cache bug happened
  // 2026-09-10 ("Push Schedule to Chain" landed on the old contract).
  invalidateCollectionContractCache(collectionId);

  // Same class of gap as the cache above (task #30): event listener
  // registration used to run ONLY at server boot, so a fresh deploy's real
  // customer mints/reveals/etc could never sync until someone manually
  // restarted the whole server. Attach immediately instead of waiting.
  await attachListenersForCollection(collectionId);

  return {
    contractAddress: proxyAddress,
    implementationAddress: implAddress,
    validatorAddress,
    network,
    txHash: deployTx?.hash ?? null,
    revealCoordinatorAddress: coordinatorAddress,
    vrfSubscriptionId: vrfSubscriptionId > 0n ? vrfSubscriptionId.toString() : null,
  };
}
