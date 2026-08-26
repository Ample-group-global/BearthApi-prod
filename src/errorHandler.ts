import { Request, Response, NextFunction } from "express";
import { HttpError } from "./errors";
import { logger } from "./logger";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const e = err as { code?: string; message?: string };
  if (e.code === "P0001") { res.status(400).json({ error: e.message }); return; }
  if (e.code === "P0002") { res.status(404).json({ error: e.message }); return; }
  if (e.code === "23505") { res.status(409).json({ error: "Duplicate entry — " + e.message }); return; }
  const msg = e.message ?? "";
  if (
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("Connection terminated") ||
    e.code === "ECONNREFUSED" ||
    e.code === "ETIMEDOUT" ||
    e.code === "ENOTFOUND"
  ) {
    logger.error("[DB] Connection error", new Error(msg));
    res.status(503).json({
      error: "Database is temporarily unavailable. Please try again in a moment.",
      cause: "db_connection_timeout",
    });
    return;
  }

  logger.error("[server] Unhandled route error", err);
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
}
