/** HTTP statuses commonly used for throttling / overload. */
export function isRateLimitedResponse(res) {
  if (!res) return false;
  return res.status === 429 || res.status === 503;
}

export class HttpRateLimitError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = "Too many requests. Please wait a minute and try again.") {
    super(message);
    this.name = "HttpRateLimitError";
  }
}

export function isHttpRateLimitError(err) {
  return err != null && (err.name === "HttpRateLimitError" || err instanceof HttpRateLimitError);
}

/** @param {Response} res */
export function throwIfRateLimited(res, message) {
  if (isRateLimitedResponse(res)) {
    throw new HttpRateLimitError(message);
  }
}
