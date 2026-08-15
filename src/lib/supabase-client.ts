import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 30_000;
const NEW_SUPABASE_API_KEY_PATTERN =
  /^sb_(?:publishable|secret)_[A-Za-z0-9_-]{20,220}$/;

interface BoundedSupabaseFetchOptions {
  timeoutMs?: number;
  fetchImplementation?: typeof globalThis.fetch;
}

function requestSignal(input: URL | RequestInfo, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  return typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? signal.reason
    : new DOMException("The Supabase request was aborted.", "AbortError");
}

const RESPONSE_BODY_READERS = new Set<PropertyKey>([
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
]);

function transferResponseBodyLifecycle(
  body: ReadableStream<Uint8Array>,
  aborted: Promise<never>,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await Promise.race([reader.read(), aborted]);
        if (result.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        cleanup();
        void reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      cleanup();
      return reader.cancel(reason);
    },
  });
}

function bindResponseBodyDeadline(
  response: Response,
  signal: AbortSignal,
  aborted: Promise<never>,
  releaseDeadline: () => void,
  cleanup: () => void,
): Response {
  let transferredBody: ReadableStream<Uint8Array> | undefined;
  return new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "body") {
        // storage-js download(...).asStream() takes ownership of the raw body.
        // Release only the short deadline: the forwarding stream keeps caller
        // aborts authoritative and performs full cleanup when it settles.
        releaseDeadline();
        if (value === null) {
          cleanup();
          return null;
        }
        try {
          transferredBody ??= transferResponseBodyLifecycle(
            value as ReadableStream<Uint8Array>,
            aborted,
            cleanup,
          );
          return transferredBody;
        } catch (error) {
          cleanup();
          throw error;
        }
      }
      if (RESPONSE_BODY_READERS.has(property) && typeof value === "function") {
        return (...args: unknown[]) => {
          if (signal.aborted) {
            cleanup();
            return Promise.reject(abortReason(signal));
          }

          let bodyRead: Promise<unknown>;
          try {
            bodyRead = Promise.resolve(Reflect.apply(value, target, args));
          } catch (error) {
            cleanup();
            return Promise.reject(error);
          }

          return Promise.race([bodyRead, aborted]).finally(cleanup);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wraps fetch with a hard per-request deadline. The caller's signal remains
 * authoritative and is composed with, rather than replaced by, the deadline.
 * The explicit abort races also prevent non-compliant fetch and body
 * implementations from leaving the caller pending forever after the signal
 * has fired. The same absolute deadline remains active while supabase-js reads
 * the response through text(), json(), blob(), or the other Body methods. A
 * caller that takes the raw response.body assumes ownership of its longer
 * streaming lifetime and releases this shorter deadline.
 */
export function createBoundedSupabaseFetch(
  options: BoundedSupabaseFetchOptions = {},
): typeof globalThis.fetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Supabase request timeout must be a positive finite number.");
  }
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

  return async (input, init) => {
    const requestController = new AbortController();
    const callerSignal = requestSignal(input, init);
    const signal = requestController.signal;
    const timeoutError = new DOMException(
      `Supabase request timed out after ${timeoutMs}ms.`,
      "TimeoutError",
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let onCallerAbort: (() => void) | undefined;
    let cleaned = false;
    const releaseDeadline = () => {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      releaseDeadline();
      if (onAbort) signal.removeEventListener("abort", onAbort);
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    };

    if (callerSignal) {
      onCallerAbort = () => requestController.abort(abortReason(callerSignal));
      if (callerSignal.aborted) {
        onCallerAbort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(abortReason(signal));
        cleanup();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (!signal.aborted) {
      timeout = setTimeout(() => requestController.abort(timeoutError), timeoutMs);
      timeout.unref?.();
    }

    try {
      let request: Promise<Response>;
      try {
        request = Promise.resolve(fetchImplementation(input, {
          ...init,
          redirect: "error",
          signal,
        }));
      } catch (error) {
        request = Promise.reject(error);
      }
      const response = await Promise.race([
        request,
        aborted,
      ]);
      if (response.body === null) {
        cleanup();
        return response;
      }
      return bindResponseBodyDeadline(
        response,
        signal,
        aborted,
        releaseDeadline,
        cleanup,
      );
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

/**
 * The hosted Supabase gateway accepts opaque publishable/secret API keys in
 * `apikey`, not as JWT bearer credentials. supabase-js copies its API key into
 * Authorization while no user session exists, so remove only that exact
 * synthetic duplicate. A distinct user/session bearer remains authoritative,
 * and legacy JWT API keys retain their historical header behavior.
 */
export function createSupabaseApiKeyAwareFetch(
  apiKey: string,
  fetchImplementation: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const opaqueApiKey = NEW_SUPABASE_API_KEY_PATTERN.test(apiKey);
  return async (input, init) => {
    if (!opaqueApiKey) {
      return fetchImplementation(input, { ...init, redirect: "error" });
    }
    const sourceHeaders = init?.headers ?? (
      typeof Request !== "undefined" && input instanceof Request
        ? input.headers
        : undefined
    );
    if (!sourceHeaders) {
      return fetchImplementation(input, { ...init, redirect: "error" });
    }
    const headers = new Headers(sourceHeaders);
    if (headers.get("authorization") !== `Bearer ${apiKey}`) {
      return fetchImplementation(input, { ...init, redirect: "error" });
    }
    headers.delete("authorization");
    return fetchImplementation(input, { ...init, headers, redirect: "error" });
  };
}

export function createServerSupabaseClient(
  url: string,
  serviceRoleOrAnonKey: string,
  options: BoundedSupabaseFetchOptions = {},
): SupabaseClient {
  return createClient(url, serviceRoleOrAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createSupabaseApiKeyAwareFetch(
        serviceRoleOrAnonKey,
        createBoundedSupabaseFetch(options),
      ),
    },
  });
}
