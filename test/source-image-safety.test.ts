import { describe, expect, it, vi } from "vitest";

import {
  createPinnedImageSourceLookup,
  isBlockedImageSourceHost,
  parseSafeImageSourceUrl,
  resolveSafeImageSourceAddresses,
} from "../src/lib/source-image-safety.js";

describe("source-image DNS rebinding protection", () => {
  it("pins the HTTP socket lookup to the address that passed validation", async () => {
    const dnsLookup = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    const resolved = await resolveSafeImageSourceAddresses(
      new URL("https://images.example.test/menu.jpg"),
      "Source URL",
      dnsLookup as never,
    );
    expect(dnsLookup).toHaveBeenCalledTimes(1);

    const connectionAddress = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      createPinnedImageSourceLookup(resolved[0]!)("images.example.test", {}, (error, address, family) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ address: address as string, family: family as number });
      });
    });

    expect(connectionAddress).toEqual({ address: "93.184.216.34", family: 4 });
    expect(dnsLookup).toHaveBeenCalledTimes(1);
  });

  it("rejects a hostname when any resolved address is private", async () => {
    const dnsLookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(resolveSafeImageSourceAddresses(
      new URL("https://images.example.test/menu.jpg"),
      "Source URL",
      dnsLookup as never,
    )).rejects.toThrow("must not resolve to local, private, or metadata network hosts");
  });

  it.each([
    "::",
    "::1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:a9fe:a9fe",
    "ff02::1",
    "2001:db8::1",
  ])("rejects non-global IPv6 source address %s", (address) => {
    expect(isBlockedImageSourceHost(address)).toBe(true);
  });

  it("allows a public global-unicast IPv6 address", () => {
    expect(isBlockedImageSourceHost("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects a literal IPv4-mapped loopback URL after URL normalization", () => {
    expect(() => parseSafeImageSourceUrl("http://[::ffff:127.0.0.1]/menu.jpg"))
      .toThrow("local, private, or metadata network hosts");
  });

  it("rejects DNS answers containing mapped metadata addresses", async () => {
    const dnsLookup = vi.fn().mockResolvedValue([{ address: "::ffff:a9fe:a9fe", family: 6 }]);
    await expect(resolveSafeImageSourceAddresses(
      new URL("https://images.example.test/menu.jpg"),
      "Source URL",
      dnsLookup as never,
    )).rejects.toThrow("must not resolve to local, private, or metadata network hosts");
  });
});
