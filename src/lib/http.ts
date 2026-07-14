export function success<T>(data: T) {
  return {
    ok: true,
    data,
  };
}

export function failure(
  message: string,
  details?: unknown,
  publicMetadata?: {
    code: string;
    recovery?: {
      eligible: boolean;
      endpoint: string;
      consumer: boolean;
      venues: Array<{ venueId: string; venueName: string }>;
    };
  } | undefined,
) {
  return {
    ok: false,
    error: {
      message,
      ...(publicMetadata ?? {}),
      ...(details === undefined ? {} : { details }),
    },
  };
}
