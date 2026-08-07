const SENSITIVE_KEY_PATTERN =
  /(authorization|bearer|token|secret|password|api.?key|auth|signature|cookie|set-cookie|email|phone|photo|image|dataurl|rawbody|payload|transcript|latitude|longitude|\blat\b|\blng\b|coordinates?|gps|precise.?location)/i;

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk_(?:live|test)_[A-Za-z0-9_]+/g,
  /\bwhsec_[A-Za-z0-9_]+/g,
  /\bAC[a-fA-F0-9]{32}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk)-[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
];

export function redactString(value: string): string {
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 6) {
    return "[REDACTED]" as T;
  }

  if (typeof value === "string") {
    return redactString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as T;
  }

  if (value && typeof value === "object") {
    const outputEntries: Array<[string, unknown]> = [];
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        continue;
      }
      outputEntries.push([
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(nested, depth + 1),
      ]);
    }
    const output = Object.fromEntries(outputEntries);
    Object.setPrototypeOf(output, null);
    return output as T;
  }

  return value;
}
