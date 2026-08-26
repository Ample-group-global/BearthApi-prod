import { ethers } from "ethers";
import { logger } from "../logger";

let _provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    const rpcUrl = process.env.ETH_RPC_URL;
    if (!rpcUrl) throw new Error("ETH_RPC_URL env var is required");
    _provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { polling: true, pollingInterval: 60_000 });
    _provider.on("error", (err: Error) => {
      logger.warn("[provider] RPC error", err);
    });
  }
  return _provider;
}
