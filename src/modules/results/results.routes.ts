import { Router } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import { resultsQuerySchema } from "./results.schemas.js";
import type { ResultsService } from "./results.service.js";

export function createResultsRouter(resultsService: ResultsService): Router {
  const router = Router();

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
