export class BoundedHttpResponseError extends Error {
  constructor() {
    super("bounded_http_response_invalid");
    this.name = "BoundedHttpResponseError";
  }
}

function invalid(): never {
  throw new BoundedHttpResponseError();
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The caller's bounded-response failure remains dominant.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // The caller's bounded-response failure remains dominant.
  }
}

async function settleBeforeAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return invalid();
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void =>
      finish(() => {
        onAbort();
        reject(new BoundedHttpResponseError());
      });
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new BoundedHttpResponseError())),
    );
    if (signal.aborted) abort();
  });
}

function validateDeclaredLength(
  response: Response,
  maximumBytes: number,
): void {
  const declared = response.headers.get("content-length");
  if (declared === null) return;
  if (!/^\d{1,16}$/.test(declared)) {
    cancelBody(response);
    invalid();
  }
  const bytes = Number(declared);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumBytes) {
    cancelBody(response);
    invalid();
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  validateDeclaredLength(response, maximumBytes);
  if (signal.aborted) {
    cancelBody(response);
    return invalid();
  }
  if (response.body === null) {
    if (
      response.headers.get("content-length") === null ||
      response.headers.get("content-length") === "0"
    )
      return "";
    return invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  try {
    while (true) {
      const next = await settleBeforeAbort(reader.read(), signal, () =>
        cancelReader(reader),
      );
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) invalid();
      totalBytes += next.value.byteLength;
      if (totalBytes > maximumBytes) {
        cancelReader(reader);
        invalid();
      }
      chunks.push(next.value);
    }
    if (signal.aborted) invalid();
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    complete = true;
    return source;
  } catch {
    cancelReader(reader);
    return invalid();
  } finally {
    if (complete) {
      try {
        reader.releaseLock();
      } catch {
        // A completed body has no remaining externally useful reader state.
      }
    }
  }
}

export async function fetchBoundedResponseText(
  fetchImpl: typeof fetch,
  request: string | URL | Request,
  init: RequestInit,
  options: {
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly response: Response; readonly source: string }> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1)
    invalid();
  let response: Response | null = null;
  let pending: Promise<Response>;
  try {
    pending = Promise.resolve(
      fetchImpl(request, { ...init, signal: options.signal }),
    );
  } catch {
    return invalid();
  }
  void pending.then(
    (lateResponse) => {
      if (options.signal.aborted) cancelBody(lateResponse);
    },
    () => undefined,
  );
  try {
    response = await settleBeforeAbort(pending, options.signal, () => {
      if (response) cancelBody(response);
    });
    const source = await readBoundedResponseText(
      response,
      options.maximumBytes,
      options.signal,
    );
    if (options.signal.aborted) invalid();
    return { response, source };
  } catch {
    if (response) cancelBody(response);
    return invalid();
  }
}
