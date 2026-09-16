import { Router } from "express";
import rateLimit from "express-rate-limit";
import pool from "../pool";

const router = Router();

const publicLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });

router.get("/collection", publicLimit, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, contract_address, contract_network, current_phase FROM nft_collections WHERE is_public_site = TRUE LIMIT 1"
    );
    const collection = rows[0];
    if (!collection) {
      res.status(404).json({ error: "No public collection configured" });
      return;
    }
    res.json({
      collectionId: collection.id,
      name: collection.name,
      contractAddress: collection.contract_address,
      network: collection.contract_network,
      currentPhase: collection.current_phase,
    });
  } catch (err) { next(err); }
});

export default router;
