import { ethers } from "ethers";
import { logger } from "../logger";

let _provider: ethers.JsonRpcProvider | null = null;

const MAX_RPC_RETRIES = 6;
const RPC_RETRY_BASE_DELAY_MS = 400;
const MAX_CONCURRENT_RPC_CALLS = 4;

// Alchemy's free tier enforces both a hard concurrency ceiling and a
// compute-units-per-second cap. A single page load already fires several
// contract getters in parallel (contractGetCollectionInfo alone issues 6),
// and two independent triggers landing close together (a manual refresh next
// to the page's 60s silent poll) can double that burst -- surfaces as a 429
// on the underlying HTTP call. A small semaphore caps how many RPC calls are
// ever in flight at once so bursts get serialized instead of firing
// unbounded in parallel; jittered backoff keeps retries from re-colliding in
// lockstep when multiple bursts get rate-limited at the same moment. Fixed
// at this single choke point instead of patching each route individually.
function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /429|too many requests|exceeded its compute units|rate limit/i.test(message);
}

// Alchemy's free tier also caps eth_getLogs to a 10-block range per call.
// resyncFromBlock() already bisects around this (see contract.service.ts),
// but ethers' own internal polling for live contract.on() event
// subscriptions calls eth_getLogs directly through this provider and hit the
// same cap uncaught -- events silently stopped being picked up whenever the
// poll needed to cover more than ~10 blocks (e.g. after any gap). Bisecting
// here fixes it for that live listener too, not just the manual resync path.
function isBlockRangeLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /block range|up to a \d+ block range/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _inFlight = 0;
const _queue: Array<() => void> = [];

async function acquireRpcSlot(): Promise<void> {
  if (_inFlight < MAX_CONCURRENT_RPC_CALLS) { _inFlight++; return; }
  await new Promise<void>((resolve) => _queue.push(resolve));
  _inFlight++;
}

function releaseRpcSlot(): void {
  _inFlight--;
  const next = _queue.shift();
  if (next) next();
}

function toHexBlock(n: number): string {
  return "0x" + n.toString(16);
}

class ResilientJsonRpcProvider extends ethers.JsonRpcProvider {
  async send(method: string, params: unknown[] | Record<string, unknown>): Promise<any> {
    if (method === "eth_getLogs" && Array.isArray(params) && params[0]) {
      return this.sendGetLogsWithBisection(params[0] as Record<string, unknown>);
    }
    return this.sendWithRetry(method, params);
  }

  private async sendWithRetry(method: string, params: unknown[] | Record<string, unknown>): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await acquireRpcSlot();
      try {
        return await super.send(method, params);
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= MAX_RPC_RETRIES) throw err;
        const jitter = Math.random() * 250;
        const delay = RPC_RETRY_BASE_DELAY_MS * 2 ** attempt + jitter;
        logger.warn(`[provider] rate-limited on ${method}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RPC_RETRIES})`);
        await sleep(delay);
      } finally {
        releaseRpcSlot();
      }
    }
  }

  private async sendGetLogsWithBisection(filter: Record<string, unknown>): Promise<any[]> {
    try {
      return await this.sendWithRetry("eth_getLogs", [filter]);
    } catch (err) {
      if (!isBlockRangeLimitError(err)) throw err;
      const from = typeof filter.fromBlock === "string" ? Number.parseInt(filter.fromBlock, 16) : NaN;
      const to = typeof filter.toBlock === "string" ? Number.parseInt(filter.toBlock, 16) : NaN;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw err;
      const mid = from + Math.floor((to - from) / 2);
      const [first, second] = await Promise.all([
        this.sendGetLogsWithBisection({ ...filter, fromBlock: toHexBlock(from), toBlock: toHexBlock(mid) }),
        this.sendGetLogsWithBisection({ ...filter, fromBlock: toHexBlock(mid + 1), toBlock: toHexBlock(to) }),
      ]);
      return [...first, ...second];
    }
  }
}

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    const rpcUrl = process.env.ETH_RPC_URL;
    if (!rpcUrl) throw new Error("ETH_RPC_URL env var is required");
    _provider = new ResilientJsonRpcProvider(rpcUrl, undefined, { polling: true, pollingInterval: 60_000 });
    _provider.on("error", (err: Error) => {
      logger.warn("[provider] RPC error", err);
    });
  }
  return _provider;
}
