import { Router } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import {
  callRunsQuerySchema,
  callSidParamSchema,
  outboundCallBodySchema,
} from "./calls.schemas.js";
import type { CallsService } from "./calls.service.js";

export function createCallsRouter(callsService: CallsService): Router {
  const router = Router();

  router.post("/outbound", async (req, res) => {
    const body = parseWithSchema(outboundCallBodySchema, req.body, "Invalid outbound call payload");
    const result = await callsService.createOutboundCall(body);

    res.status(201).json(success(result));
  });

  router.get("/", (req, res) => {
    const query = parseWithSchema(callRunsQuerySchema, req.query, "Invalid calls query");
    const calls = callsService.listCallRuns(query);

    res.json(
      success({
        count: calls.length,
        calls,
      }),
    );
  });

  router.get("/:callSid", (req, res) => {
    const params = parseWithSchema(callSidParamSchema, req.params, "Invalid call SID");
    const call = callsService.getCallRun(params.callSid);

    res.json(
      success({
        call,
      }),
    );
  });

  return router;
}
