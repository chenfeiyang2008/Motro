// 统一错误信封，符合 REST API 契约。绝不包含 stack trace 或密钥。
export interface ApiFieldError {
  path: string;
  code: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    fieldErrors?: ApiFieldError[];
    retryable: boolean;
  };
}

export function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "VALIDATION_FAILED";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "INTERNAL_ERROR";
  }
}

export function errorEnvelope(
  status: number,
  message: string,
  requestId: string,
  fieldErrors?: ApiFieldError[],
  codeOverride?: string,
): ApiErrorEnvelope {
  return {
    error: {
      code: codeOverride ?? statusToCode(status),
      message,
      requestId,
      ...(fieldErrors !== undefined ? { fieldErrors } : {}),
      retryable: status >= 500,
    },
  };
}
