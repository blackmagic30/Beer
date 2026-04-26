import { Router, type Request } from "express";

import type { AdminIngestionStatus } from "../../db/models.js";
import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import {
  adminManualCaptureSchema,
  adminMenuPhotoOcrSchema,
  adminPublishQueuedIngestionSchema,
  adminRejectQueuedIngestionSchema,
  adminSourceIngestionQueueSchema,
  adminVenueSchema,
} from "./admin.schemas.js";
import type { AdminService } from "./admin.service.js";

function getAdminSecretHeader(req: Request): string | undefined {
  const headerSecret = req.header("x-admin-secret");

  if (headerSecret && headerSecret.trim().length > 0) {
    return headerSecret.trim();
  }

  const authHeader = req.header("authorization");
  if (!authHeader) {
    return undefined;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function parseIngestionStatus(value: unknown): AdminIngestionStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  switch (normalized) {
    case "pending_review":
    case "published":
    case "rejected":
    case "failed":
      return normalized;
    default:
      return undefined;
  }
}

export function createAdminRouter(adminService: AdminService): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(success(adminService.getStatus()));
  });

  router.get("/ingestions", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const status = parseIngestionStatus(req.query.status);
      const limit =
        typeof req.query.limit === "string" && Number.isFinite(Number(req.query.limit))
          ? Number(req.query.limit)
          : 50;
      const items = adminService.listQueuedIngestions(status, limit);
      res.json(success({ items }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/venues", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const body = parseWithSchema(adminVenueSchema, req.body, "Invalid admin venue payload");
      const venue = await adminService.createVenue(body);
      res.status(201).json(success({ venue }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/captures/manual", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const body = parseWithSchema(
        adminManualCaptureSchema,
        req.body,
        "Invalid manual beer capture payload",
      );
      const result = await adminService.saveManualCapture(body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/captures/menu-photo-ocr", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const body = parseWithSchema(
        adminMenuPhotoOcrSchema,
        req.body,
        "Invalid menu photo OCR payload",
      );
      const result = await adminService.ocrMenuPhoto(body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestions/queue", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const body = parseWithSchema(
        adminSourceIngestionQueueSchema,
        req.body,
        "Invalid source ingestion payload",
      );
      const queueItem = await adminService.queueSourceIngestion(body);
      res.status(201).json(success({ queueItem }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestions/:id/publish", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const body = parseWithSchema(
        adminPublishQueuedIngestionSchema,
        req.body,
        "Invalid source review publish payload",
      );
      const result = await adminService.publishQueuedIngestion(req.params.id, body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestions/:id/reject", async (req, res, next) => {
    try {
      adminService.assertAuthorized(getAdminSecretHeader(req));
      const body = parseWithSchema(
        adminRejectQueuedIngestionSchema,
        req.body,
        "Invalid source review reject payload",
      );
      const result = adminService.rejectQueuedIngestion(req.params.id, body);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
