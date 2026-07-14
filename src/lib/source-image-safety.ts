import { lookup as defaultDnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { AppError } from "./errors.js";

export const BLOCKED_IMAGE_SOURCE_EXTENSIONS = /\.(?:svg|html?|xhtml|xml|js|mjs|css)(?:[?#].*)?$/i;

const BLOCKED_IMAGE_SOURCE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

export function getDataImageByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return 0;
  }

  const payload = dataUrl.slice(commaIndex + 1).replace(/\s/g, "");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function getDataImageBuffer(dataUrl: string): Buffer {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return Buffer.alloc(0);
  }

  return Buffer.from(dataUrl.slice(commaIndex + 1), "base64");
}

export function getDataImageMimeType(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,/i);
  return match?.[1] ? normalizeImageMimeType(match[1]) : null;
}

export function normalizeImageMimeType(value: string): string {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function detectImageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (bytes.length >= 12) {
    const brand = bytes.toString("ascii", 4, 12).toLowerCase();
    if (brand.includes("ftyphei") || brand.includes("ftypmif")) {
      return "image/heic";
    }
  }

  return null;
}

export function imageMimeTypesCompatible(detectedMimeType: string, declaredMimeType: string): boolean {
  const detected = normalizeImageMimeType(detectedMimeType);
  const declared = normalizeImageMimeType(declaredMimeType);
  if (detected === declared) {
    return true;
  }

  const heifFamily = new Set(["image/heic", "image/heif"]);
  return heifFamily.has(detected) && heifFamily.has(declared);
}

export function looksLikeActiveTextPayload(bytes: Buffer): boolean {
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, 512)).trimStart().toLowerCase();
  return /^(?:<!doctype\s+html|<html|<script|<svg|<\?xml|@import|body\s*\{|\/\*)/.test(head);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const first = parts[0]!;
  const second = parts[1]!;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && parts[2] === 100) ||
    (first === 203 && second === 0 && parts[2] === 113) ||
    first >= 224
  );
}

function ipv6ToBigInt(hostname: string): bigint | null {
  const normalized = hostname.toLowerCase().split("%")[0] ?? "";
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const values: number[] = [];
    for (const item of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      values.push(Number.parseInt(item, 16));
    }
    return values;
  };
  const left = parsePart(halves[0] ?? "");
  const right = parsePart(halves[1] ?? "");
  if (!left || !right) return null;
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function isPrivateIpv6(hostname: string): boolean {
  const value = ipv6ToBigInt(hostname);
  if (value == null) return true;

  // IPv4-mapped IPv6 addresses must inherit the IPv4 policy. URL parsing often
  // renders ::ffff:127.0.0.1 as ::ffff:7f00:1, hence the numeric check.
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    const dotted = [24, 16, 8, 0].map((shift) => String((ipv4 >>> shift) & 0xff)).join(".");
    return isPrivateIpv4(dotted);
  }

  // Only globally routable unicast space (2000::/3) is eligible. Explicitly
  // exclude documentation and transition/benchmark ranges within that block.
  if ((value >> 125n) !== 1n) return true;
  const top32 = Number(value >> 96n);
  if (top32 === 0x20010db8 || top32 === 0x20010000 || top32 === 0x20020000) return true;
  if ((value >> 80n) === 0x200100020000n) return true;
  return false;
}

export function isBlockedImageSourceHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized || BLOCKED_IMAGE_SOURCE_HOSTNAMES.has(normalized) || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipType = isIP(normalized);
  if (ipType === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipType === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

export function parseSafeImageSourceUrl(sourceUrl: string, label = "Source photo URL"): URL {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new AppError(`${label} must be a valid HTTP or HTTPS URL.`, 400);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError(`${label} must use HTTP or HTTPS.`, 400);
  }

  if (isBlockedImageSourceHost(parsed.hostname)) {
    throw new AppError(`${label} must not target local, private, or metadata network hosts.`, 400);
  }

  if (BLOCKED_IMAGE_SOURCE_EXTENSIONS.test(parsed.pathname)) {
    throw new AppError(`${label} must point to a safe image source, not HTML, SVG, script, or style content.`, 400);
  }

  return parsed;
}

export interface SafeImageSourceAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolve an image-source hostname exactly once and return only addresses that
 * are safe to connect to. Callers must use one of the returned addresses for
 * the actual socket connection; validating here and allowing the HTTP client
 * to resolve the hostname again would leave a DNS-rebinding window.
 */
export async function resolveSafeImageSourceAddresses(
  sourceUrl: URL,
  label = "Source photo URL",
  lookupHost: typeof defaultDnsLookup = defaultDnsLookup,
): Promise<SafeImageSourceAddress[]> {
  const hostname = sourceUrl.hostname.trim().replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (!hostname) {
    throw new AppError(`${label} hostname could not be resolved.`, 400);
  }
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedImageSourceHost(hostname)) {
      throw new AppError(`${label} must not target local, private, or metadata network hosts.`, 400);
    }
    return [{ address: hostname, family: literalFamily }];
  }

  let addresses: Array<{ address: string; family?: number }> = [];
  try {
    const result = await lookupHost(hostname, { all: true, verbatim: true });
    addresses = Array.isArray(result) ? result : [result];
  } catch {
    throw new AppError(`${label} hostname could not be resolved.`, 400);
  }

  if (!addresses.length || addresses.some((address) => isBlockedImageSourceHost(address.address))) {
    throw new AppError(`${label} must not resolve to local, private, or metadata network hosts.`, 400);
  }

  const resolved = addresses.flatMap((entry): SafeImageSourceAddress[] => {
    const family = entry.family === 4 || entry.family === 6 ? entry.family : isIP(entry.address);
    return family === 4 || family === 6 ? [{ address: entry.address, family }] : [];
  });
  if (!resolved.length) {
    throw new AppError(`${label} hostname could not be resolved.`, 400);
  }
  return resolved;
}

export async function assertResolvedSafeImageSourceHost(
  sourceUrl: URL,
  label = "Source photo URL",
  lookupHost: typeof defaultDnsLookup = defaultDnsLookup,
): Promise<void> {
  await resolveSafeImageSourceAddresses(sourceUrl, label, lookupHost);
}

export function createPinnedImageSourceLookup(resolved: SafeImageSourceAddress): LookupFunction {
  return (_hostname, _options, callback) => {
    callback(null, resolved.address, resolved.family);
  };
}

export function validateImageBytes(
  bytes: Buffer,
  declaredMimeType: string,
  options: {
    allowedMimeTypes: readonly string[];
    activePayloadMessage: string;
    invalidMimeMessage: string;
    mismatchMessage: string;
  },
): { mimeType: string; detectedMimeType: string } {
  const mimeType = normalizeImageMimeType(declaredMimeType);
  const allowedMimeTypes = new Set(options.allowedMimeTypes.map(normalizeImageMimeType));
  if (!mimeType || !allowedMimeTypes.has(mimeType)) {
    throw new AppError(options.invalidMimeMessage, 400);
  }

  if (looksLikeActiveTextPayload(bytes)) {
    throw new AppError(options.activePayloadMessage, 400);
  }

  const detectedMimeType = detectImageMimeType(bytes);
  if (!detectedMimeType || !imageMimeTypesCompatible(detectedMimeType, mimeType)) {
    throw new AppError(options.mismatchMessage, 400);
  }

  return { mimeType, detectedMimeType };
}

export function validateImageDataUrl(
  dataUrl: string,
  options: {
    allowedMimeTypes: readonly string[];
    maxBytes: number;
    invalidMimeMessage: string;
    tooLargeMessage: string;
    activePayloadMessage: string;
    mismatchMessage: string;
  },
): { mimeType: string; bytes: Buffer; detectedMimeType: string } {
  const mimeType = getDataImageMimeType(dataUrl);
  if (!mimeType) {
    throw new AppError(options.invalidMimeMessage, 400);
  }

  if (getDataImageByteLength(dataUrl) > options.maxBytes) {
    throw new AppError(options.tooLargeMessage, 400);
  }

  const bytes = getDataImageBuffer(dataUrl);
  const validated = validateImageBytes(bytes, mimeType, options);
  return { ...validated, bytes };
}
