import type { Request } from "express";

export const SESSION_COOKIE_NAME = "pint_path_session";

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function hasSessionCredential(req: Request): boolean {
  if (req.header("authorization") !== undefined) {
    return true;
  }

  const cookieHeader = req.header("cookie");
  if (!cookieHeader) {
    return false;
  }

  return cookieHeader.split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === SESSION_COOKIE_NAME;
  });
}

export function getSessionAuthorization(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header && /^Bearer\s+\S/i.test(header)) return header;
  const cookieToken = parseCookie(req.header("cookie"), SESSION_COOKIE_NAME);
  return cookieToken ? `Bearer ${cookieToken}` : undefined;
}
