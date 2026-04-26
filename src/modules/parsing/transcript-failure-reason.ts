const WRONG_BUSINESS_REGEX =
  /\b(?:thank you for calling|you've reached|you have reached)\b[^.\n]{0,80}\b(?:bedding|furniture|warehouse|clinic|medical|dental|physio|physiotherapy|storage|tyres?|motors?|auto|plumbing|electrical|driving range|golf square)\b|\b(?:bedding|furniture|warehouse|clinic|medical|dental|physio|physiotherapy|storage|tyres?|motors?|auto|plumbing|electrical)\b[^.\n]{0,40}\b(?:how can i help|how may i help)\b/i;
const UNINFORMATIVE_RESPONSE_REGEX = /^(?:(?:what|yeah|yes|hello|hi|sorry|pardon|come again)[\s.?!,]*)+$/i;
const IVR_KEYPAD_PROMPT_REGEX =
  /\bpress (?:(?:zero|one|two|three|four|five|six|seven|eight|nine)|[0-9]|pound|hash|star)\b|\bto connect your call\b|\bselect from the following options\b|\bfor general (?:hotel )?inquiries\b|\bfor .* press (?:(?:zero|one|two|three|four|five|six|seven|eight|nine)|[0-9]|pound|hash|star)\b/i;
const BOOKING_LINE_OR_SWITCHBOARD_REGEX =
  /\b(?:reservations?|reservation team|reservations office|events office|functions and events|private dining|guest services|front desk|hotel reception|switchboard|concierge|accommodation|rooms? division|dial an extension|if you know your party'?s extension|book online|booking enquiries?|booking line|bookings? team|central reservations?)\b/i;

export function detectTranscriptFailureReason(userTranscript: string, rawTranscript: string): string | null {
  const transcript = `${userTranscript}\n${rawTranscript}`.toLowerCase();
  const meaningfulUserTranscript = userTranscript
    .toLowerCase()
    .replace(/\b(?:uh|um|ah|er|mm+)\b/g, " ")
    .replace(/[.\s]+/g, " ")
    .trim();

  if (!transcript.trim() || !meaningfulUserTranscript) {
    return "No clear human response detected";
  }

  if (UNINFORMATIVE_RESPONSE_REGEX.test(meaningfulUserTranscript)) {
    return "No clear human response detected";
  }

  if (
    /\b(i (?:actually )?don't know|i dont know|not at that bar|let me (?:try and )?find out|let me have a look|give me (?:(?:a |one |two )?(?:sec|second|seconds))|i can quickly have a look for you|hold on (?:for )?(?:a |one )?(?:second|minute)|i'll just wait|ill just wait)\b/.test(
      transcript,
    )
  ) {
    return "Staff needed to check price but no answer returned";
  }

  if (/\bis this an ai\b|\bare you an ai\b|\bwhy do you sound irish\b/.test(transcript)) {
    return "Call challenged by staff";
  }

  if (WRONG_BUSINESS_REGEX.test(transcript)) {
    return "Wrong business reached";
  }

  if (
    IVR_KEYPAD_PROMPT_REGEX.test(transcript) ||
    /\bmenu options\b|\bplease listen carefully\b|\bfunctions and events\b|\bfor reservations\b|\bmake a reservation\b|\brunning a little late for your reservation\b|\bplease hold the line\b|\bautomated receptionist\b|\bvirtual assistant\b/.test(
      transcript,
    )
  ) {
    return "Automated menu or IVR detected";
  }

  if (
    /\bemergency broadcast\b|\bthis is a test of the emergency broadcast system\b|\blocal radio or television station\b|\bbroadcast important information\b/.test(
      transcript,
    )
  ) {
    return "Automated recording detected";
  }

  if (
    /\bout of hours\b|\boffice hours\b|\boffice is open\b|\bunable to make bookings over the phone\b|\bvia our website\b|\bexcluding public holidays\b|\breservations and events office\b/.test(
      transcript,
    )
  ) {
    return "Out-of-hours recording detected";
  }

  if (
    /\bleave a message\b|\bleave (?:your )?name and number\b|\bleave the message\b|\bbrief message\b|\bafter the beep\b|\bvoicemail\b|\bmailbox\b|\bmessage bank is full\b|\baway from the phone\b|\brecord your message\b|\bat the tone\b|\bthis number is not available\b|\bwe'?ll get back to you\b|\breturn your call as soon as possible\b|\bmessages? left on this service\b|\bcall us back again\b|\bif you'd like to make a booking\b/.test(
      transcript,
    )
  ) {
    return "Voicemail detected";
  }

  if (BOOKING_LINE_OR_SWITCHBOARD_REGEX.test(transcript)) {
    return "Booking line or switchboard reached";
  }

  return null;
}

export function shouldOverrideParsedOutcome(failureReason: string | null): boolean {
  return [
    "Wrong business reached",
    "Booking line or switchboard reached",
    "Automated menu or IVR detected",
    "Automated recording detected",
    "Out-of-hours recording detected",
    "Voicemail detected",
  ].includes(failureReason ?? "");
}
