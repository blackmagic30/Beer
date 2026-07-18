import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 30_000;

interface BoundedSupabaseFetchOptions {
  timeoutMs?: number;
  fetchImplementation?: typeof globalThis.fetch;
}

function requestSignal(input: URL | RequestInfo, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  return typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The Supabase request was aborted.", "AbortError");
}

/**
 * Wraps fetch with a hard per-request deadline. The caller's signal remains
 * authoritative and is composed with, rather than replaced by, the deadline.
 * The explicit abort race also prevents a non-compliant fetch implementation
 * from leaving the caller pending forever after the signal has fired.
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
    const deadlineController = new AbortController();
    const callerSignal = requestSignal(input, init);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineController.signal])
      : deadlineController.signal;
    const timeoutError = new DOMException(
      `Supabase request timed out after ${timeoutMs}ms.`,
      "TimeoutError",
    );
    const timeout = setTimeout(() => deadlineController.abort(timeoutError), timeoutMs);
    timeout.unref?.();

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortReason(signal));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      let request: Promise<Response>;
      try {
        request = Promise.resolve(fetchImplementation(input, { ...init, signal }));
      } catch (error) {
        request = Promise.reject(error);
      }
      return await Promise.race([
        request,
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
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
      fetch: createBoundedSupabaseFetch(options),
    },
  });
}
