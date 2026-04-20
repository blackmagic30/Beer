export function nowIso(): string {
  return new Date().toISOString();
}

export function unixSecondsToIso(unixSeconds?: number): string {
  if (!unixSeconds) {
    return nowIso();
  }

  return new Date(unixSeconds * 1000).toISOString();
}
