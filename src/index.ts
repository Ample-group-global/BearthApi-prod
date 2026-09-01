import { config as loadEnv } from "dotenv";
if (!process.env.DATABASE_URL) loadEnv({ path: ".env.local" });
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { swaggerSpec } from "./swagger";
import authRouter from "./routes/auth";
import adminRolesRouter from "./routes/admin/roles";
import adminPermissionsRouter from "./routes/admin/permissions";
import adminMenusRouter from "./routes/admin/menus";
import adminUsersRouter from "./routes/admin/users";
import nftGenRouter from "./routes/nft-gen/index";
import filebaseRouter from "./routes/filebase";
import nftSellWavesRouter from "./routes/nft-sell/waves";
import wavesRouter from "./routes/waves";
import nftsRouter from "./routes/nfts";
import nftChainRouter from "./routes/nft-chain";
import masterRouter from "./routes/master";
import pool, { startPoolKeepalive } from "./pool";
import { runPendingMigrations } from "./services/auto-migrate.service";
import { startEventListeners } from "./services/contract.service";
import { errorHandler } from "./errorHandler";
import { logger } from "./logger";
import { loadUserContext } from "./adminAuth";

const app = express();
const PORT = Number(process.env.PORT ?? 8000);

process.on("unhandledRejection", (reason) => {
  logger.warn("[process] Unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("[process] Uncaught exception", err);
});

const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map(s => s.trim());
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 2000, standardHeaders: "draft-7", legacyHeaders: false }));
app.use(loadUserContext);

app.get("/api/docs.json", (req, res) => {
  const proto = (req.headers["x-forwarded-proto"] as string) || "http";
  const host = req.headers.host ?? `localhost:${PORT}`;
  const spec = {
    ...(swaggerSpec as object),
    servers: [{ url: `${proto}://${host}`, description: "Current server" }],
  };
  res.setHeader("Content-Type", "application/json");
  res.send(spec);
});

app.get("/api/docs", (_req, res) => {
  const specUrl = "/api/docs.json";
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BearthApi V1 – API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: "${specUrl}",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
        deepLinking: true,
      });
    };
  </script>
</body>
</html>`);
});

// V1 routes: Login/Auth + RBAC + NFT Studio + Contract Ops + NFT Lists + Waves
app.use("/api/auth", authRouter);
app.use("/api/admin/roles", adminRolesRouter);
app.use("/api/admin/permissions", adminPermissionsRouter);
app.use("/api/admin/menus", adminMenusRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/nft-gen", nftGenRouter);
app.use("/api/filebase", filebaseRouter);
app.use("/api/nft-sell", nftSellWavesRouter);
app.use("/api/waves", wavesRouter);
app.use("/api/nfts", nftsRouter);
app.use("/api/nft-chain", nftChainRouter);
app.use("/api/master", masterRouter);

app.get("/api/health", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, " +
      "ROUND(pg_database_size(current_database()) / 1024.0 / 1024.0, 1) AS db_size_mb"
    );
    res.json({ status: "ok", db_size: rows[0].db_size, db_size_mb: Number(rows[0].db_size_mb) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ status: "error", error: "Database unreachable", detail: msg });
  }
});

app.use(errorHandler);

if (!process.env.VERCEL) {
  (async () => {
    await runPendingMigrations().catch(e => {
      console.error("[migrate] FATAL: migration failed on startup:", e.message);
      process.exit(1);
    });

    app.listen(PORT, () => {
      console.log(`BearthApi V1 listening on port ${PORT}`);
      startPoolKeepalive();
      if (process.env.CONTRACT_ADDRESS && process.env.ETH_RPC_URL) {
        startEventListeners();
      }
    });
  })();
}

export default app;
