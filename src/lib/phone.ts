const E164_AU_REGEX = /^\+61[2378]\d{8}$|^\+614\d{8}$/;

export function normalizeAustralianPhoneToE164(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const cleaned = trimmed.startsWith("+")
    ? `+${trimmed.slice(1).replace(/\D/g, "")}`
    : trimmed.replace(/\D/g, "");

  let candidate: string | null = null;

  if (cleaned.startsWith("+61")) {
    candidate = cleaned;
  } else if (cleaned.startsWith("61")) {
    candidate = `+${cleaned}`;
  } else if (cleaned.startsWith("0")) {
    candidate = `+61${cleaned.slice(1)}`;
  } else if (/^[2378]\d{8}$/.test(cleaned) || /^4\d{8}$/.test(cleaned)) {
    candidate = `+61${cleaned}`;
  }

  if (!candidate || !E164_AU_REGEX.test(candidate)) {
    return null;
  }

  return candidate;
}
