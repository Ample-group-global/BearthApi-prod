import pool from "../pool";

export type NftSource = "on_chain" | "off_chain" | "external";

export type NftAction =
  | "mint"
  | "transfer"
  | "reveal"
  | "sale"
  | "treasury_move"
  | "soulbound_set"
  | "soulbound_remove"
  | "wave_assigned"
  | "bulk_transfer"
  | "status_change";

export interface NftActivityParams {
  nftRecordId?:  string;
  tokenId?:      number;
  serialNumber?: string;
  action:        NftAction;
  source:        NftSource;
  platform?:     string;
  actorWallet?:  string;
  actorUserId?:  string;
  fromWallet?:   string;
  toWallet?:     string;
  txHash?:       string;
  blockNumber?:  number;
  valueEth?:     number;
  details?:      Record<string, unknown>;
}

// Fire-and-forget: logging never blocks or throws in the calling code.
export function logNftActivity(params: NftActivityParams): void {
  pool
    .query(
      `INSERT INTO nft_activity_log
         (nft_record_id, token_id, serial_number, action, source, platform,
          actor_wallet, actor_user_id, from_wallet, to_wallet,
          tx_hash, block_number, value_eth, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        params.nftRecordId  ?? null,
        params.tokenId      ?? null,
        params.serialNumber ?? null,
        params.action,
        params.source,
        params.platform     ?? "bearth",
        params.actorWallet  ?? null,
        params.actorUserId  ?? null,
        params.fromWallet   ?? null,
        params.toWallet     ?? null,
        params.txHash       ?? null,
        params.blockNumber  ?? null,
        params.valueEth     ?? null,
        JSON.stringify(params.details ?? {}),
      ],
    )
    .catch(err => console.error("[nft-log]", err.message));
}
