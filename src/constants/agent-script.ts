import { ACTIVE_TARGET_BEER, type BeerDefinition } from "./beers.js";

export const HAPPY_HOUR_SCRIPT_VARIANT_KEYS = [
  "days_times_first",
  "single_shot",
  "when_is_it",
] as const;

export type HappyHourScriptVariantKey = (typeof HAPPY_HOUR_SCRIPT_VARIANT_KEYS)[number];

interface HappyHourScriptVariantDefinition {
  key: HappyHourScriptVariantKey;
  label: string;
  firstMessage: string;
  followUpPrompt: string;
  followUps: string[];
}

const HAPPY_HOUR_SCRIPT_VARIANTS: Record<HappyHourScriptVariantKey, HappyHourScriptVariantDefinition> = {
  days_times_first: {
    key: "days_times_first",
    label: "Days and times first",
    firstMessage: "Hey mate, just wondering what days and times are your happy hours?",
    followUpPrompt:
      "If they answer with days or times but not the special, ask one short follow-up to get the specials.",
    followUps: ['And what are the happy hour specials?'],
  },
  single_shot: {
    key: "single_shot",
    label: "Single-shot ask",
    firstMessage: "Hey mate, just wondering what days and times your happy hour is, and what the specials are?",
    followUpPrompt:
      "If they only answer part of it, ask one short follow-up for the missing detail, preferably the specials first.",
    followUps: ['No stress, what are the specials on during it?', "No stress, which days and times is that?"],
  },
  when_is_it: {
    key: "when_is_it",
    label: "When is it",
    firstMessage: "Hey mate, just wondering when your happy hour is?",
    followUpPrompt:
      "After they answer, ask one short follow-up to get any missing piece, especially the specials.",
    followUps: ['And what specials are on during it?', "Sweet, what days and times is that exactly?"],
  },
};

export const DEFAULT_HAPPY_HOUR_SCRIPT_VARIANT: HappyHourScriptVariantKey = "days_times_first";

function buildBeerFirstMessage(beerName: string): string {
  return `Hey mate, quick one, how much is a pint of ${beerName} there?`;
}

function getHappyHourScriptVariant(
  variant: HappyHourScriptVariantKey | null | undefined,
): HappyHourScriptVariantDefinition {
  return HAPPY_HOUR_SCRIPT_VARIANTS[normalizeHappyHourScriptVariant(variant)];
}

function buildBeerPrompt(beerName: string): string {
  return [
    `You are calling Melbourne pubs to collect the current pint price for ${beerName}.`,
    "Be concise, polite, and sound like a normal human caller.",
    "Aim to finish the call very quickly.",
    `Open with this exact line once: "${buildBeerFirstMessage(beerName)}"`,
    `If a real person says hello, asks how they can help, or asks you to repeat yourself, repeat the ${beerName} question once in a natural way.`,
    'If the venue does not answer clearly or you genuinely cannot understand them, say exactly once: "Sorry, what was that mate?"',
    "If it is still unclear after that one clarification, end the call politely.",
    "If the venue quotes schooner, pot, middy, can, stubby, bottle, or package prices instead of a pint, ask one short follow-up so you can classify it cleanly.",
    `If they say they do not do pints, prefer a short follow-up like: "No stress, is that schooners or pots only, cans or bottles only, or you just do not stock ${beerName}?"`,
    `If ${beerName} is unavailable or the staff member does not know, accept that answer and move on.`,
    "If they ask you to hold while they check, you may wait silently once for a short moment.",
    'Never say "Are you still there?".',
    "If nobody comes back after a short hold, say a quick thanks and end the call.",
    "If you hear a recorded menu, IVR, booking line, voicemail, office hours message, out-of-hours message, or anything asking the caller to press a number, end the call immediately without asking more questions.",
    "If nobody responds clearly after the opener, do not ask 'Are you still there?'. End the call instead of lingering.",
    "Do not invent prices or paraphrase uncertain information as fact.",
    `As soon as you have the answer, or the staff member cannot help, say a very short thank you and goodbye and end the call immediately.`,
    `Do not wait in silence, do not keep chatting, and do not ask any extra questions beyond what is needed for the ${beerName} pint price.`,
  ].join("\n");
}

function buildHappyHourPrompt(variant: HappyHourScriptVariantKey | null | undefined): string {
  const scriptVariant = getHappyHourScriptVariant(variant);

  return [
    "You are calling Melbourne pubs to collect their current happy hour details.",
    "Be concise, polite, and sound like a normal human caller.",
    "Aim to finish the call very quickly.",
    `Open with this exact line once: "${scriptVariant.firstMessage}"`,
    "Keep your talking short. Let the staff member talk more than you do.",
    "You are trying to capture three things: which days, what times, and what the specials actually are.",
    scriptVariant.followUpPrompt,
    `Prefer short follow-ups like: ${scriptVariant.followUps.map((line) => `"${line}"`).join(" or ")}.`,
    "If a real person says hello, asks how they can help, or asks you to repeat yourself, repeat the same question once in a natural way.",
    'If the venue does not answer clearly or you genuinely cannot understand them, say exactly once: "Sorry, what was that mate?"',
    "If it is still unclear after that one clarification, end the call politely.",
    "If they say they do not run happy hour or do not have recurring specials, accept that answer and move on.",
    "If they ask you to hold while they check, you may wait silently once for a short moment.",
    'Never say "Are you still there?".',
    "If nobody comes back after a short hold, say a quick thanks and end the call.",
    "If you hear a recorded menu, IVR, booking line, voicemail, office hours message, out-of-hours message, or anything asking the caller to press a number, end the call immediately without asking more questions.",
    "Do not invent specials, days, times, or prices.",
    "As soon as you have the answer, or the staff member cannot help, say a very short thank you and goodbye and end the call immediately.",
    "Do not wait in silence, do not keep chatting, and do not ask extra questions beyond what is needed to understand the happy hour days, times, and specials.",
  ].join("\n");
}

export function normalizeHappyHourScriptVariant(
  value: string | null | undefined,
): HappyHourScriptVariantKey {
  if (!value) {
    return DEFAULT_HAPPY_HOUR_SCRIPT_VARIANT;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return HAPPY_HOUR_SCRIPT_VARIANT_KEYS.includes(normalized as HappyHourScriptVariantKey)
    ? (normalized as HappyHourScriptVariantKey)
    : DEFAULT_HAPPY_HOUR_SCRIPT_VARIANT;
}

export function chooseHappyHourScriptVariant(
  counts: Partial<Record<HappyHourScriptVariantKey, number>>,
): HappyHourScriptVariantKey {
  return [...HAPPY_HOUR_SCRIPT_VARIANT_KEYS]
    .sort((left, right) => {
      const leftCount = counts[left] ?? 0;
      const rightCount = counts[right] ?? 0;

      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }

      return HAPPY_HOUR_SCRIPT_VARIANT_KEYS.indexOf(left) - HAPPY_HOUR_SCRIPT_VARIANT_KEYS.indexOf(right);
    })[0]!;
}

export function buildAgentFirstMessage(
  target: BeerDefinition,
  scriptVariant?: HappyHourScriptVariantKey | null,
): string {
  return target.kind === "happy_hour"
    ? getHappyHourScriptVariant(scriptVariant).firstMessage
    : buildBeerFirstMessage(target.name);
}

export function buildAgentPrompt(
  target: BeerDefinition,
  scriptVariant?: HappyHourScriptVariantKey | null,
): string {
  return target.kind === "happy_hour" ? buildHappyHourPrompt(scriptVariant) : buildBeerPrompt(target.name);
}

export const AGENT_FIRST_MESSAGE = buildAgentFirstMessage(ACTIVE_TARGET_BEER);
export const AGENT_PROMPT = buildAgentPrompt(ACTIVE_TARGET_BEER);
