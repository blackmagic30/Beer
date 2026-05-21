import { Router } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import { resultsQuerySchema } from "./results.schemas.js";
import type { ResultsService } from "./results.service.js";
import type { BusinessService } from "../business/business.service.js";

export function createResultsRouter(resultsService: ResultsService, businessService: BusinessService): Router {
  const router = Router();

  router.use((req, _res, next) => {
    try {
      businessService.requireAdmin(req.header("authorization") ?? undefined);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/", (req, res) => {
    const query = parseWithSchema(resultsQuerySchema, req.query, "Invalid results query");
    const calls = resultsService.list(query);

    res.json(
      success({
        count: calls.length,
        results: calls,
      }),
    );
  });

  return router;
}
