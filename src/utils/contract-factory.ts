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
// ethers wraps eth_call errors into a CALL_EXCEPTION ("missing revert data")
// before they ever reach this provider's catch block -- the real 429 sits
// nested at err.info.error.code/message, not in err.message. Checking only
// the top-level message let every read-only contract call (tokenURI(),
// blockedAccounts(), everything using provider.call()) silently skip retry
// on a rate limit while writes/raw sends were still covered. Serializing the
// whole error (message + shortMessage + info + error) before testing catches
// both shapes without needing to enumerate ethers' every wrapping variant.
function collectErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  const anyErr = err as unknown as Record<string, unknown>;
  if (typeof anyErr.shortMessage === "string") parts.push(anyErr.shortMessage);
  for (const key of ["info", "error"] as const) {
    if (anyErr[key] != null) {
      try { parts.push(JSON.stringify(anyErr[key])); } catch { /* ignore */ }
    }
  }
  return parts.join(" | ");
}

function isRateLimitError(err: unknown): boolean {
  return /429|too many requests|exceeded its compute units|rate limit/i.test(collectErrorText(err));
}

// Alchemy's free tier also caps eth_getLogs to a 10-block range per call.
// resyncFromBlock() already bisects around this (see contract.service.ts),
// but ethers' own internal polling for live contract.on() event
// subscriptions calls eth_getLogs directly through this provider and hit the
// same cap uncaught -- events silently stopped being picked up whenever the
// poll needed to cover more than ~10 blocks (e.g. after any gap). Bisecting
// here fixes it for that live listener too, not just the manual resync path.
function isBlockRangeLimitError(err: unknown): boolean {
  return /block range|up to a \d+ block range/i.test(collectErrorText(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RPC_CALL_TIMEOUT_MS = 20_000;

class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`RPC call ${method} did not respond within ${ms}ms`);
    this.name = "RpcTimeoutError";
  }
}

// ethers' underlying fetch has no default timeout -- a free/public RPC node
// that's temporarily overloaded or having a bad moment doesn't error, it
// just never responds, and the whole call (and everything awaiting it, e.g.
// a multi-step contract deploy) hangs indefinitely. The existing retry loop
// only helps once something actually throws. Found live 2026-09-14: a Test1
// contract deploy hung for 4+ minutes with zero transaction ever broadcast
// (nonce unchanged) and no error logged -- confirmed stuck on a pre-tx RPC
// call, not a slow confirmation. Racing every call against a timeout turns
// a silent hang into a retryable error, and since the public endpoint is a
// load-balanced multi-node service, a retry has a real chance of landing on
// a healthier node.
function withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(method, RPC_CALL_TIMEOUT_MS)), RPC_CALL_TIMEOUT_MS);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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

export class ResilientJsonRpcProvider extends ethers.JsonRpcProvider {
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
        return await withTimeout(super.send(method, params), method);
      } catch (err) {
        const retryable = isRateLimitError(err) || err instanceof RpcTimeoutError;
        if (!retryable || attempt >= MAX_RPC_RETRIES) throw err;
        const jitter = Math.random() * 250;
        const delay = RPC_RETRY_BASE_DELAY_MS * 2 ** attempt + jitter;
        const reason = err instanceof RpcTimeoutError ? "timed out" : "rate-limited";
        logger.warn(`[provider] ${reason} on ${method}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RPC_RETRIES})`);
        await sleep(delay);
      } finally {
        releaseRpcSlot();
      }
    }
  }

  private async sendGetLogsWithBisection(filter: Record<string, unknown>): Promise<any[]> {
    // A freshly-attached live listener's initial getBlockNumber() call and a
    // subsequent "block" event can land on different backend nodes of a
    // load-balanced public RPC (ethereum-sepolia-rpc.publicnode.com) with
    // slightly different sync heights -- producing a momentary
    // fromBlock > toBlock range that's guaranteed invalid on any node.
    // Retrying or bisecting it can't help (there's nothing to converge on);
    // returning empty is correct since the next poll cycle naturally
    // re-requests a corrected range once the cursor catches up. Found live
    // 2026-09-14 right after attaching a freshly-deployed collection's
    // listeners -- was surfacing as a repeating "invalid block range params"
    // unhandled rejection.
    const fromEarly = typeof filter.fromBlock === "string" ? Number.parseInt(filter.fromBlock, 16) : NaN;
    const toEarly = typeof filter.toBlock === "string" ? Number.parseInt(filter.toBlock, 16) : NaN;
    if (Number.isFinite(fromEarly) && Number.isFinite(toEarly) && fromEarly > toEarly) return [];

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
    // ethers' live contract.on() event listener is driven by this provider's
    // own block-polling cadence -- PollingEventSubscriber only checks
    // eth_getLogs when a new "block" event fires, which itself only fires
    // once per pollingInterval. 8s (vs the 60s default) keeps it responsive
    // without materially increasing request volume (still one lightweight
    // eth_blockNumber call per interval). Note: this alone did NOT fix live
    // sync -- the real bug was in contract.service.ts's attachListenersFor
    // reading txHash/blockNumber off the wrong object shape (see comment
    // there). Keeping the faster interval anyway since it's a genuine, if
    // minor, improvement now that the real bug is fixed.
    _provider = new ResilientJsonRpcProvider(rpcUrl, undefined, { polling: true, pollingInterval: 8_000 });
    _provider.on("error", (err: Error) => {
      logger.warn("[provider] RPC error", err);
    });
  }
  return _provider;
}
