import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import * as svc from "../../services/nft-gen.service";

const VALID_TIERS = ["legendary", "epic", "rare", "common"];

const router = Router();

router.put("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const body = req.body ?? {};
    if (body.rarityTier && !VALID_TIERS.includes(body.rarityTier.toLowerCase())) {
      res.status(422).json({ error: "rarityTier must be one of: legendary, epic, rare, common." }); return;
    }
    if (body.rarityTier) body.rarityTier = body.rarityTier.toLowerCase();
    if (body.rarityWeight !== undefined && (!Number.isFinite(body.rarityWeight) || body.rarityWeight <= 0)) {
      res.status(422).json({ error: "rarityWeight must be a positive number — use isActive:false to disable a trait." }); return;
    }
    const trait = await svc.updateTrait(req.params.id, body);
    if (!trait) { res.status(404).json({ error: "Trait not found." }); return; }
    res.json({ trait });
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.manage_layers");
    const result = await svc.deleteTrait(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
