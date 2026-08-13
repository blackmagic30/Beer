import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import {
  OPENAI_MENU_OCR_COST_BOUND_MAX_PROMPT_BYTES,
  OPENAI_MENU_OCR_COST_BOUND_MODEL,
  OPENAI_MENU_OCR_COST_BOUND_WORST_CASE_CENTS,
  assertOpenAiMenuOcrCostBoundRequest,
  externalProviderCostBudgetInternals,
  reserveOpenAiMenuOcrRollingBudget,
} from "../src/lib/external-provider-cost-budget.js";

const reserveAt = externalProviderCostBudgetInternals.reserveOpenAiMenuOcrRollingBudgetAt;

function repository() {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  return {
    database,
    repository: new SystemStateRepository(asAsyncSqliteDatabase(database)),
  };
}

describe("external provider rolling cost budget", () => {
  it("derives the five-cent reservation from the frozen public price and token ceilings", () => {
    expect(OPENAI_MENU_OCR_COST_BOUND_WORST_CASE_CENTS).toBe(5);
  });

  it("atomically reserves five cents per attempt and denies the twenty-first", async () => {
    const fixture = repository();
    try {
      const reservations = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        reserveAt(
          fixture.repository,
          `2026-08-13T00:00:${String(index).padStart(2, "0")}.000Z`,
        )));
      expect(reservations.every((entry) => entry.allowed)).toBe(true);
      expect(reservations.map((entry) => entry.reservedCents).sort((a, b) => a - b))
        .toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 5));

      await expect(reserveAt(
        fixture.repository,
        "2026-08-13T00:01:00.000Z",
      )).resolves.toEqual(expect.objectContaining({
        allowed: false,
        reservedCents: 100,
        remainingCents: 0,
        reservationCount: 20,
      }));
    } finally {
      fixture.database.close();
    }
  });

  it("does not reset at a UTC calendar-month boundary", async () => {
    const fixture = repository();
    try {
      const august = await reserveAt(
        fixture.repository,
        "2026-08-31T23:59:59.999Z",
      );
      const september = await reserveAt(
        fixture.repository,
        "2026-09-01T00:00:00.000Z",
      );
      expect(august.stateKey).toBe(september.stateKey);
      expect(september.stateKey).toContain(":rolling-31-day");
      expect(september.reservedCents).toBe(10);
    } finally {
      fixture.database.close();
    }
  });

  it("preserves a later committed database timestamp during contention", async () => {
    const fixture = repository();
    try {
      await reserveAt(fixture.repository, "2026-08-13T00:00:01.000Z");
      const reservation = await reserveAt(
        fixture.repository,
        "2026-08-13T00:00:00.000Z",
      );
      const state = await fixture.repository.get<{
        reservationTimestamps: string[];
      }>(reservation.stateKey);
      expect(state?.value.reservationTimestamps).toEqual([
        "2026-08-13T00:00:01.000Z",
        "2026-08-13T00:00:01.000Z",
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed on malformed or rebound persisted state", async () => {
    const fixture = repository();
    try {
      const key = externalProviderCostBudgetInternals.budgetStateKey;
      await fixture.repository.set(key, {
        schemaVersion: "pintpath-external-provider-rolling-budget/v1",
        environment: "permanent-staging",
        providerSurface: "openai-menu-ocr",
        window: "rolling-31-day",
        maximumCents: 100,
        reservationUnitCents: 5,
        reservationTimestamps: [
          "2026-08-02T00:00:00.000Z",
          "2026-08-01T00:00:00.000Z",
        ],
      }, "2026-08-01T00:00:00.000Z");
      await expect(reserveAt(
        fixture.repository,
        "2026-08-02T00:00:00.000Z",
      )).rejects.toThrow("rolling budget state is invalid");
    } finally {
      fixture.database.close();
    }
  });

  it("keeps the cap for the full rolling 31-day window", async () => {
    const fixture = repository();
    try {
      for (let index = 0; index < 20; index += 1) {
        expect((await reserveAt(
          fixture.repository,
          "2026-08-01T00:00:00.000Z",
        )).allowed).toBe(true);
      }
      expect((await reserveAt(
        fixture.repository,
        "2026-09-01T00:00:00.000Z",
      )).allowed).toBe(false);
      expect(await reserveAt(
        fixture.repository,
        "2026-09-01T00:00:00.001Z",
      )).toEqual(expect.objectContaining({
        allowed: true,
        reservedCents: 5,
        reservationCount: 1,
      }));
    } finally {
      fixture.database.close();
    }
  });

  it("pins the exact model, image count, prompt bytes, and absence of PDFs", () => {
    expect(() => assertOpenAiMenuOcrCostBoundRequest({
      model: OPENAI_MENU_OCR_COST_BOUND_MODEL,
      prompt: "extract",
      imageCount: 6,
      documentCount: 0,
    })).not.toThrow();
    expect(() => assertOpenAiMenuOcrCostBoundRequest({
      model: "gpt-4.1-mini",
      prompt: "extract",
      imageCount: 1,
      documentCount: 0,
    })).toThrow("exact reviewed model snapshot");
    expect(() => assertOpenAiMenuOcrCostBoundRequest({
      model: OPENAI_MENU_OCR_COST_BOUND_MODEL,
      prompt: "x".repeat(OPENAI_MENU_OCR_COST_BOUND_MAX_PROMPT_BYTES + 1),
      imageCount: 1,
      documentCount: 0,
    })).toThrow("prompt exceeds");
    expect(() => assertOpenAiMenuOcrCostBoundRequest({
      model: OPENAI_MENU_OCR_COST_BOUND_MODEL,
      prompt: "extract",
      imageCount: 1,
      documentCount: 1,
    })).toThrow("forbids PDF");
  });

  it("takes the production rolling-window timestamp from the shared database clock", async () => {
    const fixture = repository();
    try {
      const reservation = await reserveOpenAiMenuOcrRollingBudget(
        fixture.repository,
        {
          dialect: "sqlite",
          prepare: () => ({
            run: async () => ({ changes: 0 }),
            get: async () => ({ now: "2031-02-01T00:00:00.000Z" }),
            all: async () => [],
          }),
        },
      );
      expect(reservation.stateKey).toContain(":rolling-31-day");
      expect(reservation.reservedCents).toBe(5);
    } finally {
      fixture.database.close();
    }
  });
});
