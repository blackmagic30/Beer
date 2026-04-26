import { describe, expect, it } from "vitest";

import {
  detectTranscriptFailureReason,
  shouldOverrideParsedOutcome,
} from "../src/modules/parsing/transcript-failure-reason.js";

describe("detectTranscriptFailureReason", () => {
  it("detects staff-checking hold transcripts", () => {
    const result = detectTranscriptFailureReason(
      "Oh, I actually don't know. I'm not at that bar. Let me try and find out for you. Give me two seconds.",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: Oh, I actually don't know. I'm not at that bar.",
    );

    expect(result).toBe("Staff needed to check price but no answer returned");
  });

  it("detects brief hold-to-check responses", () => {
    const result = detectTranscriptFailureReason(
      "I can quickly have a look for you, just can you hold on for a second?",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: I can quickly have a look for you, just can you hold on for a second?",
    );

    expect(result).toBe("Staff needed to check price but no answer returned");
  });

  it("detects let-me-have-a-look responses", () => {
    const result = detectTranscriptFailureReason(
      "Uh, give me one second. Let me have a look.",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: Uh, give me one second. Let me have a look.",
    );

    expect(result).toBe("Staff needed to check price but no answer returned");
  });

  it("detects give-me-a-sec responses", () => {
    const result = detectTranscriptFailureReason(
      "Pint of Guinness? Um, just give me a sec.",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: Pint of Guinness? Um, just give me a sec.",
    );

    expect(result).toBe("Staff needed to check price but no answer returned");
  });

  it("detects challenge transcripts", () => {
    const result = detectTranscriptFailureReason(
      "Excuse me? Is this an AI?",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: Is this an AI?",
    );

    expect(result).toBe("Call challenged by staff");
  });

  it("detects voicemail-style booking recordings", () => {
    const result = detectTranscriptFailureReason(
      "If you'd like to make a booking, we'll get back to you as soon as possible.",
      "USER: If you'd like to make a booking, we'll get back to you as soon as possible.",
    );

    expect(result).toBe("Voicemail detected");
  });

  it("detects leave-your-name voicemail prompts", () => {
    const result = detectTranscriptFailureReason(
      "Please leave your name and number and we'll return your call as soon as possible.",
      "USER: Please leave your name and number and we'll return your call as soon as possible.",
    );

    expect(result).toBe("Voicemail detected");
  });

  it("detects message bank full recordings as voicemail", () => {
    const result = detectTranscriptFailureReason(
      "0481785190. This message bank is full. Please try again later.",
      "USER: 0481785190. This message bank is full. Please try again later.",
    );

    expect(result).toBe("Voicemail detected");
  });

  it("detects away-from-the-phone greetings as voicemail", () => {
    const result = detectTranscriptFailureReason(
      "We're currently away from the phone. Please leave your name, number, and a brief message.",
      "USER: We're currently away from the phone. Please leave your name, number, and a brief message.",
    );

    expect(result).toBe("Voicemail detected");
  });

  it("detects reservations office recordings as out-of-hours style", () => {
    const result = detectTranscriptFailureReason(
      "The Reservations and Events Office is open Monday through Friday from 9:00 a.m. until 5:00 p.m.",
      "USER: The Reservations and Events Office is open Monday through Friday from 9:00 a.m. until 5:00 p.m.",
    );

    expect(result).toBe("Out-of-hours recording detected");
  });

  it("detects virtual assistant venue greetings as IVR", () => {
    const result = detectTranscriptFailureReason(
      "You're automated receptionist. I'm here to help while the team are busy. I'm the virtual assistant for the hotel.",
      "USER: You're automated receptionist. I'm here to help while the team are busy. I'm the virtual assistant for the hotel.",
    );

    expect(result).toBe("Automated menu or IVR detected");
  });

  it("detects reservation website prompts as IVR", () => {
    const result = detectTranscriptFailureReason(
      "For reservations, please visit our website. Please hold the line.",
      "USER: For reservations, please visit our website. Please hold the line.",
    );

    expect(result).toBe("Automated menu or IVR detected");
  });

  it("detects higher-number keypad prompts as IVR", () => {
    const result = detectTranscriptFailureReason(
      "To connect your call, press eight. To connect your call, press nine.",
      "USER: To connect your call, press eight. To connect your call, press nine.",
    );

    expect(result).toBe("Automated menu or IVR detected");
  });

  it("detects wrong-business greetings", () => {
    const result = detectTranscriptFailureReason(
      "... . Huffman Bedding, how can I help?. Oh, we don't have Guinness, so zero.",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: ...\nAGENT: Sorry, what was that mate?\nUSER: Huffman Bedding, how can I help?\nAGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: Oh, we don't have Guinness, so zero.",
    );

    expect(result).toBe("Wrong business reached");
  });

  it("overrides parsed outcomes for wrong-business calls", () => {
    expect(shouldOverrideParsedOutcome("Wrong business reached")).toBe(true);
    expect(shouldOverrideParsedOutcome("Automated menu or IVR detected")).toBe(true);
    expect(shouldOverrideParsedOutcome("Voicemail detected")).toBe(true);
    expect(shouldOverrideParsedOutcome("Call challenged by staff")).toBe(false);
  });

  it("treats repeated what-style replies as no clear human response", () => {
    const result = detectTranscriptFailureReason(
      "What? Yeah. What?",
      "AGENT: Hey mate, quick one, how much is a pint of Guinness there?\nUSER: What? Yeah.\nAGENT: Sorry, what was that mate?\nUSER: What?",
    );

    expect(result).toBe("No clear human response detected");
  });
});
