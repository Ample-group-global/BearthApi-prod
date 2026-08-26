import { Router } from "express";
import { requirePermission } from "../../adminAuth";
import * as svc from "../../services/nft-gen.service";

const router = Router();

// Upload batch lifecycle

router.get("/:id", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.view");
    const data = await svc.getUploadBatch(req.params.id);
    if (!data) { res.status(404).json({ error: "Upload batch not found." }); return; }
    res.json(data);
  } catch (e) { next(e); }
});

router.post("/:id/start", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const result = await svc.startUploadBatch(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

router.patch("/:id/progress", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { uploadedItems } = req.body ?? {};
    if (uploadedItems === undefined || Number(uploadedItems) < 0) {
      res.status(422).json({ error: "uploadedItems must be >= 0." }); return;
    }
    const result = await svc.progressUploadBatch(req.params.id, Number(uploadedItems));
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/:id/complete", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const result = await svc.completeUploadBatch(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

router.post("/:id/fail", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { error: errorMsg } = req.body ?? {};
    if (!errorMsg) { res.status(422).json({ error: "error message is required." }); return; }
    const result = await svc.failUploadBatch(req.params.id, errorMsg);
    res.json(result);
  } catch (e) { next(e); }
});

// Item IPFS update

router.patch("/items/:itemId/ipfs", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.upload_ipfs");
    const { ipfsImageCid, ipfsMetadataCid } = req.body ?? {};
    if (!ipfsImageCid) { res.status(422).json({ error: "ipfsImageCid is required." }); return; }
    if (!ipfsMetadataCid) { res.status(422).json({ error: "ipfsMetadataCid is required." }); return; }
    const result = await svc.updateItemIpfs(req.params.itemId, { ipfsImageCid, ipfsMetadataCid });
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
