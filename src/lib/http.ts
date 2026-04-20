export function success<T>(data: T) {
  return {
    ok: true,
    data,
  };
}

export function failure(message: string, details?: unknown) {
  return {
    ok: false,
    error: {
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}
