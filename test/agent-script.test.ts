import { describe, expect, it } from "vitest";

import {
  buildAgentFirstMessage,
  buildAgentPrompt,
  chooseHappyHourScriptVariant,
  type HappyHourScriptVariantKey,
} from "../src/constants/agent-script.js";
import { getBeerByKey } from "../src/constants/beers.js";

describe("happy hour script variants", () => {
  it("prefers the least-used variant when rotating", () => {
    const variant = chooseHappyHourScriptVariant({
      days_times_first: 4,
      single_shot: 2,
      when_is_it: 3,
    });

    expect(variant).toBe<HappyHourScriptVariantKey>("single_shot");
  });

  it("uses a shorter days-and-times opener for the default happy hour variant", () => {
    const target = getBeerByKey("happy_hour");

    expect(buildAgentFirstMessage(target, "days_times_first")).toBe(
      "Hey mate, just wondering what days and times are your happy hours?",
    );
    expect(buildAgentPrompt(target, "days_times_first")).toContain("And what are the happy hour specials?");
  });

  it("keeps beer calls on the beer price script", () => {
    const target = getBeerByKey("carlton_draft");

    expect(buildAgentFirstMessage(target)).toContain("how much is a pint of Carlton Draft");
    expect(buildAgentPrompt(target)).toContain("current pint price for Carlton Draft");
  });
});
