import { BeerPriceResultsRepository } from "../../db/beer-price-results.repository.js";
import { CallRunsRepository } from "../../db/call-runs.repository.js";
import { buildCallRunViews } from "../calls/call-runs.presenter.js";

import type { ResultsQuery } from "./results.schemas.js";

export class ResultsService {
  constructor(
    private readonly callRunsRepository: CallRunsRepository,
    private readonly beerPriceResultsRepository: BeerPriceResultsRepository,
    private readonly parseConfidenceThreshold: number,
  ) {}

  list(query: ResultsQuery) {
    const fetchLimit = query.needsReview ? Math.max(query.limit * 5, 100) : query.limit;
    const callRuns = this.callRunsRepository.list({
      callSid: query.callSid,
      venueName: query.venueName,
      suburb: query.suburb,
      testMode: query.testMode,
      limit: fetchLimit,
    });
    const rows = this.beerPriceResultsRepository.listByCallSids(
      callRuns
        .map((callRun) => callRun.callSid)
        .filter((callSid): callSid is string => Boolean(callSid)),
    );
    const calls = buildCallRunViews(callRuns, rows, this.parseConfidenceThreshold).filter((call) =>
      query.needsReview === undefined ? true : call.needsReview === query.needsReview,
    );

    return calls.slice(0, query.limit);
  }
}
