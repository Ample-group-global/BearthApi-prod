import { ethers, type Contract } from "ethers";
import pool from "../pool";
import BearthTimelock_ABI from "../abi/BearthTimelock.abi.json";
import BearthNFT_ABI from "../abi/BearthNFT.abi.json";
import { getProvider } from "../utils/contract-factory";
import { HttpError } from "../errors";
import { resolveCollectionContractAddress } from "./contract.service";

let _timelockRO: Contract | null = null;
let _timelockSigned: Contract | null = null;

function getTimelockAddress(): string {
  const addr = process.env.TIMELOCK_ADDRESS;
  if (!addr) throw new Error("TIMELOCK_ADDRESS env var is required");
  return addr;
}

function getTimelockReadOnly(): Contract {
  if (!_timelockRO) {
    _timelockRO = new ethers.Contract(getTimelockAddress(), BearthTimelock_ABI, getProvider());
  }
  return _timelockRO;
}

function getTimelockWithSigner(): Contract {
  if (!_timelockSigned) {
    const privateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
    if (!privateKey) throw new Error("CONTRACT_PRIVATE_KEY (or FIXED_PRIVATE_KEY) env var is required");
    const signer = new ethers.Wallet(privateKey, getProvider());
    _timelockSigned = new ethers.Contract(getTimelockAddress(), BearthTimelock_ABI, signer);
  }
  return _timelockSigned;
}

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const nftInterface = new ethers.Interface(BearthNFT_ABI);

const ACCESS_CONTROL_IFACE = new ethers.Interface([
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

async function runTimelockCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const raw = err as { shortMessage?: string; message?: string; data?: string; info?: { error?: { data?: string } } };
    const data = raw.data ?? raw.info?.error?.data;
    let isAccessControlError = false;
    if (data && data !== "0x") {
      try { isAccessControlError = !!ACCESS_CONTROL_IFACE.parseError(data); } catch { }
    }
    if (isAccessControlError) {
      throw new HttpError(400, `${label} failed: this wallet does not hold the required Timelock role (needs PROPOSER_ROLE to schedule)`);
    }
    throw new HttpError(400, `${label} failed: ${raw.shortMessage ?? raw.message ?? "unknown error"}`);
  }
}

export async function scheduleTreasuryWalletChange(
  newWallet: string,
  createdBy: string | null,
  collectionId: string
): Promise<{ operationId: string; eta: string; scheduledTxHash: string }> {
  if (!ethers.isAddress(newWallet)) throw new HttpError(400, "Invalid treasury wallet address");

  const contractAddress = await resolveCollectionContractAddress(collectionId);

  const data = nftInterface.encodeFunctionData("setTreasuryWallet", [newWallet]);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const predecessor = ZERO_BYTES32;

  const timelockRO = getTimelockReadOnly();
  const delay: bigint = await timelockRO.getMinDelay();
  const operationId: string = await timelockRO.hashOperation(contractAddress, 0, data, predecessor, salt);

  const timelock = getTimelockWithSigner();
  const receipt = await runTimelockCall("Schedule treasury wallet change", async () => {
    const tx = await timelock.schedule(contractAddress, 0, data, predecessor, salt, delay);
    return tx.wait(1) as Promise<ethers.TransactionReceipt>;
  });

  const eta = new Date((Math.floor(Date.now() / 1000) + Number(delay)) * 1000);

  await pool.query(
    `INSERT INTO treasury_timelock_ops
       (operation_id, purpose, target, value_wei, call_data, predecessor, salt, new_value, eta, scheduled_tx_hash, created_by, collection_id)
     VALUES ($1,'setTreasuryWallet',$2,'0',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [operationId, contractAddress, data, predecessor, salt, newWallet, eta.toISOString(), receipt.hash, createdBy, collectionId]
  );

  return { operationId, eta: eta.toISOString(), scheduledTxHash: receipt.hash };
}

export interface TimelockOpStatus {
  operationId: string;
  purpose: string;
  newValue: string | null;
  eta: string;
  ready: boolean;
  done: boolean;
  scheduledTxHash: string;
  executedTxHash: string | null;
  executedAt: string | null;
}

export async function getLatestTimelockOp(purpose: string, collectionId: string): Promise<TimelockOpStatus | null> {
  const { rows } = await pool.query(
    `SELECT * FROM treasury_timelock_ops
     WHERE purpose = $1 AND collection_id = $2 AND cancelled_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [purpose, collectionId]
  );
  const row = rows[0];
  if (!row) return null;

  const timelockRO = getTimelockReadOnly();
  const [ready, done]: [boolean, boolean] = await Promise.all([
    timelockRO.isOperationReady(row.operation_id),
    timelockRO.isOperationDone(row.operation_id),
  ]);

  return {
    operationId: row.operation_id,
    purpose: row.purpose,
    newValue: row.new_value,
    eta: row.eta,
    ready,
    done: done || !!row.executed_at,
    scheduledTxHash: row.scheduled_tx_hash,
    executedTxHash: row.executed_tx_hash,
    executedAt: row.executed_at,
  };
}

export async function executeTimelockOp(operationId: string, collectionId: string): Promise<{ txHash: string }> {
  const { rows } = await pool.query(
    `SELECT * FROM treasury_timelock_ops WHERE operation_id = $1`,
    [operationId]
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "No scheduled operation found with that id");
  if (row.collection_id !== collectionId) throw new HttpError(400, "This operation was not scheduled for the selected collection");
  if (row.executed_at) throw new HttpError(400, "This operation has already been executed");

  const timelockRO = getTimelockReadOnly();
  const ready: boolean = await timelockRO.isOperationReady(operationId);
  if (!ready) throw new HttpError(400, "This operation is not ready yet -- the timelock delay has not passed");

  const timelock = getTimelockWithSigner();
  const receipt = await runTimelockCall("Execute treasury wallet change", async () => {
    const tx = await timelock.execute(row.target, BigInt(row.value_wei), row.call_data, row.predecessor, row.salt);
    return tx.wait(1) as Promise<ethers.TransactionReceipt>;
  });

  await pool.query(
    `UPDATE treasury_timelock_ops SET executed_at = NOW(), executed_tx_hash = $2 WHERE operation_id = $1`,
    [operationId, receipt.hash]
  );

  return { txHash: receipt.hash };
}
