import { describe, expect, it } from "vitest";

import {
  buildAgentFirstMessage,
  buildAgentPrompt,
  chooseHappyHourScriptVariant,
  type HappyHourScriptVariantKey,
} from "../src/constants/agent-script.js";
import { getBeerByKey } from "../src/constants/beers.js";

describe("happy hour script variants", () => {
  it("uses the optimized default variant for automatic happy-hour calls", () => {
    const variant = chooseHappyHourScriptVariant({
      days_times_first: 4,
      single_shot: 2,
      when_is_it: 3,
    });

    expect(variant).toBe<HappyHourScriptVariantKey>("days_times_first");
  });

  it("uses the optimized two-step opener for the default happy hour variant", () => {
    const target = getBeerByKey("happy_hour");

    expect(buildAgentFirstMessage(target, "days_times_first")).toBe(
      "Hey mate, quick one, what days and times are your happy hours?",
    );
    expect(buildAgentPrompt(target, "days_times_first")).toContain("And what specials are on during that?");
  });

  it("keeps the happy-hour agent concise and extraction-focused", () => {
    const prompt = buildAgentPrompt(getBeerByKey("happy_hour"), "days_times_first");

    expect(prompt).toContain("Ask no more than two questions total");
    expect(prompt).toContain("days, times, and specials");
    expect(prompt).toContain("stop talking and let the staff member answer fully");
    expect(prompt).toContain('do not restart with "Hey mate"');
    expect(prompt).toContain("audio-message prompt");
    expect(prompt).toContain("Do not explain the project, mention AI, mention maps, mention scripts, or mention data collection");
  });

  it("keeps beer calls on the beer price script", () => {
    const target = getBeerByKey("carlton_draft");

    expect(buildAgentFirstMessage(target)).toContain("how much is a pint of Carlton Draft");
    expect(buildAgentPrompt(target)).toContain("current pint price for Carlton Draft");
  });
});
