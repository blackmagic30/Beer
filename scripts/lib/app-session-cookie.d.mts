export interface HeaderReader {
  get(name: string): string | null;
  getSetCookie?(): string[];
}

export interface ExactAppSessionCookie {
  readonly token: string;
  readonly cookieHeader: string;
}

export function readSetCookieHeaders(headers: HeaderReader): string[];

export function extractExactAppSessionCookie(
  setCookieHeaders: readonly string[],
  responseUrl: string | URL,
  options?: { readonly allowPurposeCredential?: boolean },
): ExactAppSessionCookie;
