import { describe, expect, it } from "vitest";

import { ElevenLabsService } from "../src/lib/elevenlabs.js";

describe("provider webhook safety", () => {
  it("fails closed for ElevenLabs webhooks when production requires a signing secret", async () => {
    const service = new ElevenLabsService(undefined, undefined, true);

    await expect(service.verifyAndParseWebhook("{}")).rejects.toThrow(
      "ElevenLabs webhook verification is not configured",
    );
  });

  it("can still parse unsigned ElevenLabs webhook payloads when explicit unsigned mode is used", async () => {
    const service = new ElevenLabsService(undefined, undefined, false);

    await expect(service.verifyAndParseWebhook("{\"type\":\"post_call\"}")).resolves.toEqual({
      type: "post_call",
    });
  });
});
