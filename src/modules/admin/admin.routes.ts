import { Router, type Request } from "express";

import type { AdminIngestionStatus } from "../../db/models.js";
import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import {
  adminBulkRejectQueuedIngestionsSchema,
  adminManualCaptureSchema,
  adminMenuPhotoOcrSchema,
  adminPublishQueuedIngestionSchema,
  adminRejectQueuedIngestionSchema,
  adminSourceIngestionQueueSchema,
  adminVenueSchema,
} from "./admin.schemas.js";
import type { AdminService } from "./admin.service.js";
import type { BusinessService } from "../business/business.service.js";

function requireRoleAdmin(req: Request, businessService: BusinessService): void {
  businessService.requireAdmin(req.header("authorization") ?? undefined);
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

function parseBoundedInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 0), max);
}

export function createAdminRouter(adminService: AdminService, businessService: BusinessService): Router {
  const router = Router();

  router.use((req, _res, next) => {
    try {
      requireRoleAdmin(req, businessService);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/status", (_req, res) => {
    res.json(success(adminService.getStatus()));
  });

  router.get("/places/search", async (req, res, next) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q : "";
      res.json(success(await adminService.searchGoogleVenuePlaces(query)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/places/:placeId", async (req, res, next) => {
    try {
      res.json(success(await adminService.getGoogleVenuePlace(req.params.placeId)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ingestions", async (req, res, next) => {
    try {
      const status = parseIngestionStatus(req.query.status);
      const limit = parseBoundedInteger(req.query.limit, 50, 100);
      const offset = parseBoundedInteger(req.query.offset, 0, 10_000);
      const items = adminService.listQueuedIngestions(status, limit, offset);
      const total = adminService.countQueuedIngestions(status);
      res.json(success({ items, total, limit, offset }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/venues", async (req, res, next) => {
    try {
      const body = parseWithSchema(adminVenueSchema, req.body, "Invalid admin venue payload");
      const venue = await adminService.createVenue(body);
      res.status(201).json(success({ venue }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/captures/manual", async (req, res, next) => {
    try {
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

  router.post("/ingestions/reject", async (req, res, next) => {
    try {
      const body = parseWithSchema(
        adminBulkRejectQueuedIngestionsSchema,
        req.body,
        "Invalid source review bulk reject payload",
      );
      const result = adminService.rejectQueuedIngestions(body);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestions/:id/publish", async (req, res, next) => {
    try {
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
