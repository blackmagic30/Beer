import { Router, type Request } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import {
  adminManualCaptureSchema,
  adminMenuPhotoOcrSchema,
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

export function createAdminRouter(adminService: AdminService): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(success(adminService.getStatus()));
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

  return router;
}
