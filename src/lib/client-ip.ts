import net from "node:net";

import type { Request } from "express";

function isRailwayRuntime(): boolean {
  // RAILWAY_REPLICA_ID is deployment-only. Environment/service variables can
  // also be injected by `railway run` into a local process, where trusting a
  // caller-provided platform header would be unsafe.
  return Boolean(process.env.RAILWAY_REPLICA_ID?.trim());
}

export function normalizeIpAddress(value: string | null | undefined): string | null {
  let candidate = value?.trim() ?? "";
  if (!candidate || candidate.includes(",")) {
    return null;
  }

  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }

  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex > 0 && candidate.includes(":")) {
    candidate = candidate.slice(0, zoneIndex);
  }

  const mappedIpv4 = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedIpv4 && net.isIP(mappedIpv4) === 4) {
    return mappedIpv4;
  }

  const version = net.isIP(candidate);
  if (version === 4) {
    return candidate;
  }
  if (version === 6) {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }

  return null;
}

/**
 * Railway documents X-Real-IP as the original client address on public HTTP
 * requests. Its edge path can contain a variable number of forwarding hops,
 * so Express's numeric trust-proxy result is not stable enough for security
 * controls. Only use the platform header inside an actual Railway replica;
 * local and other deployments continue to use Express's configured
 * proxy result/socket address and cannot opt in by sending a request header.
 */
export function getClientIp(req: Request): string | null {
  if (isRailwayRuntime()) {
    const railwayClientIp = normalizeIpAddress(req.get("x-real-ip"));
    if (railwayClientIp) {
      return railwayClientIp;
    }

    // Never fall through to req.ip or the Railway proxy socket. Both can vary
    // with the edge path and would recreate split rate-limit buckets. Returning
    // null makes IP-based enforcement fail closed while audit/session context
    // accurately records that no client IP was available.
    return null;
  }

  return normalizeIpAddress(req.ip)
    ?? normalizeIpAddress(req.socket.remoteAddress)
    ?? null;
}

export function getRateLimitIdentity(req: Request): string | null {
  return getClientIp(req);
}
