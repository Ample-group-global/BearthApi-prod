import { ethers } from "ethers";
import pool from "../pool";
import { logger } from "../logger";
import BearthNFTArtifact from "../contracts/deploy-abi/BearthNFT.json";
import BearthProxyArtifact from "../contracts/deploy-abi/BearthProxy.json";
import ValidatorArtifact from "../contracts/deploy-abi/CreatorTokenTransferValidator.json";
import RevealCoordinatorArtifact from "../contracts/deploy-abi/BearthRevealCoordinator.json";
import BearthTimelockArtifact from "../contracts/deploy-abi/BearthTimelock.json";
import BearthTreasuryArtifact from "../contracts/deploy-abi/BearthTreasury.json";
import BearthAirdropArtifact from "../contracts/deploy-abi/BearthAirdrop.json";
import { invalidateCollectionContractCache, attachListenersForCollection } from "./contract.service";
import { ResilientJsonRpcProvider } from "../utils/contract-factory";

const VRF_COORDINATOR: Record<DeployNetwork, string> = {
  sepolia: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
  mainnet: "0xD7f86b4b8Cae7D942340FF628F82735b7a20893a",
};
const VRF_KEY_HASH: Record<DeployNetwork, string> = {
  sepolia: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
  mainnet: "0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9",
};

const OPENSEA_SEAPORT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
const LEVEL_2 = 2;
const OPERATOR_WHITELIST = 0;
const MIN_DEPLOY_ETH = "0.05";

export type DeployNetwork = "sepolia" | "mainnet";

const WAVE_FIB = [1, 1, 2, 3, 5, 8, 13];
const WAVE_FIB_SUM = 33;
function fibonacciWaveQtys(totalSupply: number): number[] {
  const qtys = WAVE_FIB.map((f) => Math.floor((totalSupply * f) / WAVE_FIB_SUM));
  const remainder = totalSupply - qtys.reduce((a, b) => a + b, 0);
  qtys[6] += remainder;
  return qtys;
}

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

// Deploy is a long, multi-step, real-money on-chain operation with no
// undo. Two collections' deploys running concurrently was never intended
// -- found live 2026-09-14 when a UI test script clicked the wrong
// collection's Deploy button while unaware another deploy might be in
// flight. A single in-memory lock across the whole process is enough
// (this API runs as one instance) and turns "click twice" or "two admins
// deploying different collections at once" into a clear error instead of
// two deploys racing for the same RPC/wallet nonce.
let _deployInProgress: string | null = null;

export async function deployCollectionContract(params: {
  collectionId: string;
  network: DeployNetwork;
  blindBoxUri: string;
  deployedBy: string | null;
}) {
  const { collectionId, network, blindBoxUri, deployedBy } = params;

  if (_deployInProgress) {
    throw new Error(`A contract deploy is already in progress for collection ${_deployInProgress}. Wait for it to finish before starting another.`);
  }
  _deployInProgress = collectionId;
  try {
    return await deployCollectionContractInner({ collectionId, network, blindBoxUri, deployedBy });
  } finally {
    _deployInProgress = null;
  }
}

async function deployCollectionContractInner(params: {
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
  if (!Number.isInteger(totalSupply) || totalSupply < 33) {
    throw new Error("Collection supply must be a whole number of at least 33 before deploying a contract (so every wave gets at least 1 token).");
  }

  // The Deploy button is already hidden in the UI unless generation/export
  // is fully done, but that's a display-only gate -- nothing stopped this
  // function itself from being called directly with a collection whose
  // nft_records was never actually populated. Enforcing it here too means
  // the precondition holds regardless of which UI path (or future one)
  // calls this function.
  const { rows: nrRows } = await pool.query(
    "SELECT COUNT(*) AS cnt FROM nft_records WHERE collection_id = $1",
    [collectionId],
  );
  const syncedCount = Number(nrRows[0]?.cnt ?? 0);
  if (syncedCount < totalSupply) {
    throw new Error(
      `Cannot deploy: nft_records has ${syncedCount}/${totalSupply} rows synced for this collection. ` +
      `Finish generation/export so every token is synced into nft_records before deploying a contract.`,
    );
  }

  const waveQtys = fibonacciWaveQtys(totalSupply);

  const { rpcUrl, privateKey, emergencyWallet, adminGovernanceWallet } = getNetworkConfig(network);
  // Deploy is a long chain of ~10 sequential on-chain transactions
  // (validator, implementation, proxy+init, role grants, VRF coordinator,
  // wiring, ownership transfer). A plain JsonRpcProvider has zero retry/
  // backoff protection -- fine while pointed at paid Alchemy infra, but
  // fragile now that the RPC env vars point at a free public endpoint
  // (switched 2026-09-12 after Alchemy's monthly quota ran out). Reusing
  // the same resilient wrapper the rest of the API already relies on for
  // exactly this kind of transient rate-limit/network hiccup.
  const provider = new ResilientJsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const adminWallet = signer.address;
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

  // A real BearthTimelock per collection, deployed first since both
  // BearthTreasury's admin and BearthNFT's UPGRADER_ROLE/TREASURY_TIMELOCK_ROLE
  // now route through it, instead of sitting directly on a human-controlled
  // wallet with zero delay. Mirrors the exact config already used and
  // documented in scripts/setup-timelock.ts for the original single
  // contract: admin-only proposer, open executor (anyone can execute an
  // already-public, already-approved change), self-governed (no key can
  // shorten/bypass the delay).
  const FORTY_EIGHT_HOURS = 48 * 60 * 60;
  const TimelockFactory = new ethers.ContractFactory(BearthTimelockArtifact.abi, BearthTimelockArtifact.bytecode, signer);
  const timelock = await TimelockFactory.deploy(
    FORTY_EIGHT_HOURS, [adminGovernanceWallet], [ethers.ZeroAddress], ethers.ZeroAddress,
  );
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  logger.info(`[contract-deploy] BearthTimelock deployed: ${timelockAddress} (48h delay, proposer ${adminGovernanceWallet})`);

  // BearthTreasury was never actually deployed as part of this flow before --
  // treasuryWallet was just the deploy wallet's own EOA, with none of
  // BearthTreasury's withdrawal limits/destination allowlist/pause switch
  // protecting anything. DEFAULT_ADMIN_ROLE (which can change those limits
  // or pause state) goes to the Timelock, not a wallet -- so even a
  // compromised admin key can't instantly disable the caps. WITHDRAWER_ROLE
  // (routine withdrawals) stays on the operations wallet -- day-to-day
  // withdrawals shouldn't need a 48h delay, only CHANGING the rules should.
  const treasuryLimitPrefix = network === "mainnet" ? "MAINNET" : "SEPOLIA";
  const maxPerTxEnv = process.env[`TREASURY_MAX_PER_TX_ETH_${treasuryLimitPrefix}`];
  const dailyLimitEnv = process.env[`TREASURY_DAILY_LIMIT_ETH_${treasuryLimitPrefix}`];
  if (network === "mainnet" && (!maxPerTxEnv || !dailyLimitEnv)) {
    throw new Error(
      "Refusing to deploy to mainnet: TREASURY_MAX_PER_TX_ETH_MAINNET and TREASURY_DAILY_LIMIT_ETH_MAINNET " +
      "must be set explicitly -- these are real financial limits protecting real funds and must be a " +
      "deliberate decision, not a default.",
    );
  }
  const maxPerTxWei = ethers.parseEther(maxPerTxEnv ?? "10");
  const dailyLimitWei = ethers.parseEther(dailyLimitEnv ?? "50");
  // Without seeding at least one approved destination here, the very first
  // withdrawEth()/transferNFT() call on a fresh Treasury would need
  // setApprovedDestination() first -- DEFAULT_ADMIN_ROLE-gated, i.e.
  // Timelock-gated, i.e. a mandatory 48h wait before Treasury could move
  // anything at all. Seeding the operations wallet now is a one-time
  // bootstrap inside the same trusted deploy transaction, not a bypass of
  // governance -- every later change to this list still goes through the
  // Timelock.
  const TreasuryFactory = new ethers.ContractFactory(BearthTreasuryArtifact.abi, BearthTreasuryArtifact.bytecode, signer);
  const treasuryContract = await TreasuryFactory.deploy(timelockAddress, operationsWallet, maxPerTxWei, dailyLimitWei, [operationsWallet]);
  await treasuryContract.waitForDeployment();
  const treasuryAddress = await treasuryContract.getAddress();
  logger.info(`[contract-deploy] BearthTreasury deployed: ${treasuryAddress} (admin=Timelock, withdrawer=${operationsWallet}, maxPerTx=${ethers.formatEther(maxPerTxWei)} ETH, dailyLimit=${ethers.formatEther(dailyLimitWei)} ETH, initial approved destination=${operationsWallet})`);

  // Batch ETH airdrop utility, ported from the old contract. Owner is the
  // Timelock (not a hot wallet) since the only owner-gated function,
  // rescue(), can pull the contract's full ETH balance -- the same
  // 48h-delay governance model already used for Treasury/Validator.
  const AirdropFactory = new ethers.ContractFactory(BearthAirdropArtifact.abi, BearthAirdropArtifact.bytecode, signer);
  const airdropContract = await AirdropFactory.deploy(timelockAddress);
  await airdropContract.waitForDeployment();
  const airdropAddress = await airdropContract.getAddress();
  logger.info(`[contract-deploy] BearthAirdrop deployed: ${airdropAddress} (owner=Timelock)`);

  const ValidatorFactory = new ethers.ContractFactory(ValidatorArtifact.abi, ValidatorArtifact.bytecode, signer);
  const validator = await ValidatorFactory.deploy(signer.address);
  await validator.waitForDeployment();
  const validatorAddress = await validator.getAddress();
  logger.info(`[contract-deploy] Validator deployed: ${validatorAddress}`);

  const BearthNFTFactory = new ethers.ContractFactory(BearthNFTArtifact.abi, BearthNFTArtifact.bytecode, signer);
  const impl = await BearthNFTFactory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  logger.info(`[contract-deploy] Implementation deployed: ${implAddress}`);

  const initData = BearthNFTFactory.interface.encodeFunctionData("initialize", [
    collection.name,
    collection.symbol,
    blindBoxUri,
    adminWallet,
    operationsWallet,
    emergencyWallet,
    treasuryAddress,
    validatorAddress,
    waveQtys,
  ]);
  const ProxyFactory = new ethers.ContractFactory(BearthProxyArtifact.abi, BearthProxyArtifact.bytecode, signer);
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  const deployTx = proxy.deploymentTransaction();
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  logger.info(`[contract-deploy] Proxy deployed: ${proxyAddress}`);

  const proxyContract = new ethers.Contract(proxyAddress, BearthNFTArtifact.abi, signer);
  const revealRole = await proxyContract.REVEAL_ROLE();
  await (await proxyContract.grantRole(revealRole, operationsWallet)).wait();
  logger.info(`[contract-deploy] REVEAL_ROLE granted to operations wallet ${operationsWallet}`);

  const validatorContract = new ethers.Contract(validatorAddress, ValidatorArtifact.abi, signer);
  await (await validatorContract.setTransferSecurityLevelOfCollection(proxyAddress, LEVEL_2)).wait();
  await (await validatorContract.addAccountsToWhitelist(proxyAddress, OPERATOR_WHITELIST, [OPENSEA_SEAPORT])).wait();
  logger.info(`[contract-deploy] Validator configured (LEVEL_2, OpenSea Seaport whitelisted)`);

  // Validator's owner (plain, single-step Ownable) can instantly de-whitelist
  // marketplaces or change the security level for this collection with zero
  // delay or public notice -- a centralization/DoS risk flagged in this
  // session's security audit. Config calls above must happen BEFORE this,
  // since transferOwnership is immediate and irrevocable on plain Ownable.
  await (await validatorContract.transferOwnership(timelockAddress)).wait();
  logger.info(`[contract-deploy] Validator ownership transferred to Timelock ${timelockAddress} -- security-level/whitelist changes now require the same 48h delay`);

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

  // Chainlink's VRF Coordinator checks msg.sender against the subscription's
  // registered consumer list -- a freshly-deployed RevealCoordinator that
  // isn't registered will have requestReveal() revert with InvalidConsumer
  // the first time reveal is actually triggered. Register it now, at deploy
  // time, instead of leaving that discovery for whoever runs reveal later.
  if (vrfSubscriptionId > 0n) {
    const vrfAbi = [
      "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)",
      "function addConsumer(uint256 subId, address consumer)",
    ];
    const vrfCoordinator = new ethers.Contract(vrfCoordinatorAddr, vrfAbi, signer);
    const sub = await vrfCoordinator.getSubscription(vrfSubscriptionId);
    const alreadyRegistered = (sub.consumers as string[]).some(
      (c) => c.toLowerCase() === coordinatorAddress.toLowerCase(),
    );
    if (!alreadyRegistered) {
      await (await vrfCoordinator.addConsumer(vrfSubscriptionId, coordinatorAddress)).wait();
      logger.info(`[contract-deploy] RevealCoordinator registered as VRF consumer on subscription ${vrfSubscriptionId}`);
    }
  }

  const coordinatorRevealRole = await proxyContract.REVEAL_ROLE();
  await (await proxyContract.grantRole(coordinatorRevealRole, coordinatorAddress)).wait();
  await (await proxyContract.setRevealCoordinator(coordinatorAddress)).wait();
  logger.info(`[contract-deploy] Coordinator wired: REVEAL_ROLE granted + setRevealCoordinator() called`);

  await (await (coordinator as any).transferOwnership(adminGovernanceWallet)).wait();
  logger.warn(`[contract-deploy] Coordinator ownership transfer PROPOSED to ${adminGovernanceWallet} -- ` +
    `still owned by the deploy wallet until that wallet calls acceptOwnership() on ${coordinatorAddress} directly (e.g. via Etherscan). ` +
    (network === "mainnet" ? "REQUIRED before mainnet reveal is safe." : "Recommended before treating this deploy as production-representative."));

  // Previously granted directly to adminGovernanceWallet -- a single wallet
  // key could then upgrade this contract or redirect the treasury wallet
  // instantly, with zero delay or public notice, defeating the entire point
  // of having these as separate governance-gated roles. Routing them through
  // the Timelock instead means every such change is public on-chain for 48h
  // before it can take effect, and self-administration (see BearthNFT.sol's
  // initialize()) means DEFAULT_ADMIN_ROLE can never re-grant these directly
  // to a wallet later either.
  const upgraderRole = await proxyContract.UPGRADER_ROLE();
  const treasuryTimelockRole = await proxyContract.TREASURY_TIMELOCK_ROLE();
  await (await proxyContract.grantRole(upgraderRole, timelockAddress)).wait();
  await (await proxyContract.grantRole(treasuryTimelockRole, timelockAddress)).wait();
  logger.info(`[contract-deploy] UPGRADER_ROLE + TREASURY_TIMELOCK_ROLE granted to Timelock ${timelockAddress} (48h delay, not a direct wallet)`);

  await pool.query(
    `UPDATE nft_collections SET
       contract_address = $1, contract_network = $2, contract_validator_address = $3,
       contract_deploy_tx_hash = $4, contract_deployed_at = now(), contract_deployed_by = $5,
       contract_reveal_coordinator_address = $7, contract_vrf_subscription_id = $8,
       contract_treasury_address = $9, contract_timelock_address = $10, contract_airdrop_address = $11
     WHERE id = $6`,
    [proxyAddress, network, validatorAddress, deployTx?.hash ?? null, deployedBy, collectionId,
     coordinatorAddress, vrfSubscriptionId > 0n ? vrfSubscriptionId.toString() : null,
     treasuryAddress, timelockAddress, airdropAddress],
  );

  invalidateCollectionContractCache(collectionId);

  await attachListenersForCollection(collectionId);

  return {
    contractAddress: proxyAddress,
    implementationAddress: implAddress,
    validatorAddress,
    network,
    txHash: deployTx?.hash ?? null,
    revealCoordinatorAddress: coordinatorAddress,
    vrfSubscriptionId: vrfSubscriptionId > 0n ? vrfSubscriptionId.toString() : null,
    treasuryAddress,
    timelockAddress,
    airdropAddress,
  };
}
