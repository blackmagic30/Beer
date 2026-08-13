"use strict";

/**
 * Historical compatibility stub. The former implementation created an
 * unbounded direct OpenAI client outside Pint Path's reviewed menu-OCR
 * authority. Keep the export fail-closed so stale callers receive an explicit
 * error without reading credentials or contacting a provider.
 */
async function extractData() {
  throw new Error(
    "Legacy extractData provider access is disabled; use the reviewed menu OCR service boundary.",
  );
}

export { extractData };
