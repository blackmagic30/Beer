import { describe, expect, it, vi } from "vitest";

import {
  AccountDeletionNotificationError,
  buildAccountDeletionCompletionMessage,
  createMockAccountDeletionNotificationProvider,
  createResendAccountDeletionNotificationProvider,
  decryptAccountDeletionDestination,
  encryptAccountDeletionDestination,
  mapResendAccountDeletionLastEvent,
  serializeResendAccountDeletionRequest,
} from "../src/lib/account-deletion-notification.js";

const requestId = "delete-request-123";
const encryptionSecret = "a-dedicated-account-deletion-secret-with-more-than-32-bytes";

const message = buildAccountDeletionCompletionMessage({
  requestId,
  destination: "deleted-user@example.com",
  from: "Pint Path <support@pintpath.au>",
  replyTo: "admin@pintpath.au",
  publicBaseUrl: "https://pintpath.au",
  supportEmail: "admin@pintpath.au",
});

describe("account deletion destination encryption", () => {
  it("encrypts the destination with request-bound AES-256-GCM authentication", () => {
    const encryptedDestination = encryptAccountDeletionDestination({
      requestId,
      destination: "deleted-user@example.com",
      encryptionSecret,
    });

    expect(encryptedDestination).toMatchObject({ version: 1, algorithm: "aes-256-gcm" });
    expect(JSON.stringify(encryptedDestination)).not.toContain("deleted-user@example.com");
    expect(decryptAccountDeletionDestination({
      requestId,
      encryptedDestination,
      encryptionSecret,
    })).toBe("deleted-user@example.com");
    expect(() => decryptAccountDeletionDestination({
      requestId: "a-different-request",
      encryptedDestination,
      encryptionSecret,
    })).toThrow("could not be authenticated");
  });

  it("rejects short secrets and tampered ciphertext without leaking sensitive values", () => {
    expect(() => encryptAccountDeletionDestination({
      requestId,
      destination: "deleted-user@example.com",
      encryptionSecret: "too-short",
    })).toThrow("at least 32 bytes");

    const encryptedDestination = encryptAccountDeletionDestination({
      requestId,
      destination: "deleted-user@example.com",
      encryptionSecret,
    });
    encryptedDestination.ciphertext = `${encryptedDestination.ciphertext[0] === "A" ? "B" : "A"}${encryptedDestination.ciphertext.slice(1)}`;
    try {
      decryptAccountDeletionDestination({ requestId, encryptedDestination, encryptionSecret });
      throw new Error("Expected authentication to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountDeletionNotificationError);
      expect(String(error)).not.toContain("deleted-user@example.com");
      expect(String(error)).not.toContain(encryptionSecret);
    }
  });
});

describe("account deletion completion message", () => {
  it("provides equivalent plain and HTML completion content with support and legal links", () => {
    expect(message.subject).toContain("deletion is complete");
    expect(message.text).toContain("Support: admin@pintpath.au");
    expect(message.text).toContain("Terms: https://pintpath.au/terms.html");
    expect(message.text).toContain("Privacy: https://pintpath.au/privacy.html");
    expect(message.html).toContain('href="mailto:admin@pintpath.au"');
    expect(message.html).toContain('href="https://pintpath.au/terms.html"');
    expect(message.html).toContain('href="https://pintpath.au/privacy.html"');
    expect(message.html).toContain(requestId);
  });
});

describe("account deletion notification providers", () => {
  it("provides a deterministic mock ID and a queryable delivered status", async () => {
    const provider = createMockAccountDeletionNotificationProvider();
    const first = await provider.send(message);
    const second = await provider.send(message);

    expect(second).toEqual(first);
    await expect(provider.getStatus(first.id)).resolves.toEqual({
      providerId: first.id,
      lastEvent: "delivered",
      deliveryStatus: "delivered",
    });
    await expect(provider.getStatus("mock-never-sent")).resolves.toMatchObject({
      deliveryStatus: "unknown",
    });
  });

  it("posts to Resend with the deletion request idempotency key and returns its provider ID", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-provider-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = createResendAccountDeletionNotificationProvider({
      apiKey: "re_test_account_deletion",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(provider.send(message)).resolves.toEqual({ id: "email-provider-123" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer re_test_account_deletion",
      "Idempotency-Key": `pintpath-account-deletion/${requestId}`,
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: message.from,
      to: ["deleted-user@example.com"],
      reply_to: "admin@pintpath.au",
      subject: message.subject,
      text: message.text,
      html: message.html,
      tags: [{ name: "message_type", value: "account_deletion_completion" }],
    });
    expect(init?.body).toBe(serializeResendAccountDeletionRequest(message));
  });

  it("keeps the Resend key send-only and maps webhook/provider event names", () => {
    const fetchMock = vi.fn();
    const provider = createResendAccountDeletionNotificationProvider({
      apiKey: "re_test_account_deletion",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(provider.getStatus).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mapResendAccountDeletionLastEvent("delivered").deliveryStatus).toBe("delivered");
    expect(mapResendAccountDeletionLastEvent("sent").deliveryStatus).toBe("pending");
    expect(mapResendAccountDeletionLastEvent("bounced").deliveryStatus).toBe("failed");
    expect(mapResendAccountDeletionLastEvent("complained").deliveryStatus).toBe("delivered");
    expect(mapResendAccountDeletionLastEvent("suppressed").deliveryStatus).toBe("failed");
    expect(mapResendAccountDeletionLastEvent("new_provider_event").deliveryStatus).toBe("unknown");
  });

  it("classifies retryable, permanent, and uncertain failures without leaking provider content", async () => {
    const retryable = createResendAccountDeletionNotificationProvider({
      apiKey: "re_secret_retryable",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        message: "deleted-user@example.com re_secret_retryable",
      }), { status: 503 })) as typeof fetch,
    });
    const permanent = createResendAccountDeletionNotificationProvider({
      apiKey: "re_secret_permanent",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        message: "deleted-user@example.com re_secret_permanent",
      }), { status: 422 })) as typeof fetch,
    });
    const uncertain = createResendAccountDeletionNotificationProvider({
      apiKey: "re_secret_uncertain",
      fetchImpl: vi.fn(async () => { throw new Error("deleted-user@example.com re_secret_uncertain"); }) as typeof fetch,
    });

    for (const [provider, expectedOutcome, forbidden] of [
      [retryable, "retryable", "re_secret_retryable"],
      [permanent, "permanent", "re_secret_permanent"],
      [uncertain, "uncertain", "re_secret_uncertain"],
    ] as const) {
      try {
        await provider.send(message);
        throw new Error("Expected send to fail");
      } catch (error) {
        expect(error).toMatchObject({ outcome: expectedOutcome });
        expect(String(error)).not.toContain("deleted-user@example.com");
        expect(String(error)).not.toContain(forbidden);
      }
    }
  });

  it("distinguishes safe concurrent idempotency retries from changed-payload conflicts", async () => {
    const concurrent = createResendAccountDeletionNotificationProvider({
      apiKey: "re_test_concurrent",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        name: "concurrent_idempotent_requests",
        message: "original request still running",
      }), { status: 409 })) as typeof fetch,
    });
    const changedPayload = createResendAccountDeletionNotificationProvider({
      apiKey: "re_test_changed_payload",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        name: "invalid_idempotent_request",
        message: "different payload",
      }), { status: 409 })) as typeof fetch,
    });
    const unknownConflict = createResendAccountDeletionNotificationProvider({
      apiKey: "re_test_unknown_conflict",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 409 })) as typeof fetch,
    });

    await expect(concurrent.send(message)).rejects.toMatchObject({ outcome: "retryable", statusCode: 409 });
    await expect(changedPayload.send(message)).rejects.toMatchObject({ outcome: "idempotency_conflict", statusCode: 409 });
    await expect(unknownConflict.send(message)).rejects.toMatchObject({ outcome: "uncertain", statusCode: 409 });
  });

  it("times out an indeterminate send as uncertain", async () => {
    const provider = createResendAccountDeletionNotificationProvider({
      apiKey: "re_test_timeout",
      timeoutMs: 5,
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch,
    });

    await expect(provider.send(message)).rejects.toMatchObject({ outcome: "uncertain" });
  });
});
