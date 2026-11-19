'use strict';

/**
 * Retry helpers for outbound API calls.
 *
 * Only idempotent operations are retried here. Sends (Telegram/WhatsApp messages) are never retried
 * by this module: a retry could duplicate a delivered message, so those paths rely on idempotency
 * keys and explicit "force" resends instead.
 *
 * @typedef {Object} RetryOptions
 * @property {number} [attempts] Total attempts (default 3).
 * @property {number} [baseMs] First backoff delay (default 200 ms).
 * @property {number} [maxMs] Backoff cap (default 2000 ms).
 * @property {number} [jitter] Fractional jitter, 0..1 (default 0.3).
 * @property {(error: unknown) => boolean} [retryIf] Decide whether an error is retryable.
 * @property {(attempt: number, error: unknown) => void} [onRetry] Observability hook per retry.
 * @property {(ms: number) => Promise<void>} [sleep] Injectable sleep for tests.
 *
 * @typedef {Object} RetryableErrorLike
 * @property {number} [status]
 * @property {number} [retryAfterMs]
 * @property {string} [code]
 */

/** @param {unknown} value @returns {RetryableErrorLike} */
function asErrorLike(value) {
  return value && typeof value === 'object' ? /** @type {RetryableErrorLike} */ (value) : {};
}

/** @param {number} status @returns {boolean} */
function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || status >= 500;
}

/** @param {unknown} error @returns {boolean} */
function isRetryable(error) {
  const info = asErrorLike(error);
  if (typeof info.status === 'number') return isRetryableStatus(info.status);
  if (info.code === 'ECONNRESET' || info.code === 'ETIMEDOUT' || info.code === 'ECONNREFUSED' || info.code === 'ENOTFOUND' || info.code === 'EAI_AGAIN') return true;
  const message = error instanceof Error ? error.message : String(error == null ? '' : error);
  return /fetch failed|network|timeout|temporar/i.test(message);
}

/**
 * @param {number} attempt One-based attempt number that just failed.
 * @param {RetryOptions} options
 * @returns {number} Delay in milliseconds.
 */
function backoffMs(attempt, options) {
  const base = Math.max(10, options.baseMs == null ? 200 : options.baseMs);
  const max = Math.max(base, options.maxMs == null ? 2000 : options.maxMs);
  const jitter = Math.min(1, Math.max(0, options.jitter == null ? 0.3 : options.jitter));
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.round(Math.max(10, Math.min(max, raw * factor)));
}

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async function with exponential backoff and jitter.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
async function withRetry(fn, options = {}) {
  const attempts = Number.isInteger(options.attempts) && Number(options.attempts) > 0 ? Number(options.attempts) : 3;
  const sleep = options.sleep || defaultSleep;
  const retryIf = options.retryIf || isRetryable;
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryIf(error)) throw error;
      const info = asErrorLike(error);
      const delay = typeof info.retryAfterMs === 'number' ? info.retryAfterMs : backoffMs(attempt, options);
      if (options.onRetry) options.onRetry(attempt, error);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * @typedef {Object} FetchLikeResponse
 * @property {number} status
 * @property {{ get: (name: string) => string | null }} headers
 * @property {() => Promise<unknown>} json
 *
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<FetchLikeResponse>} FetchLike
 */

/**
 * Fetch with retries for idempotent requests: 429 and 5xx responses are retried, honouring Retry-After.
 * @param {FetchLike} fetchImpl
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 * @param {RetryOptions} [options]
 * @returns {Promise<FetchLikeResponse>}
 */
async function fetchWithRetry(fetchImpl, url, init, options = {}) {
  return withRetry(async () => {
    const response = await fetchImpl(url, init);
    if (response.status === 429 || response.status >= 500) {
      const retryAfterSeconds = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : '');
      throw Object.assign(new Error(`http_${response.status}`), {
        status: response.status,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined,
      });
    }
    return response;
  }, options);
}

module.exports = {
  withRetry,
  fetchWithRetry,
  isRetryable,
  isRetryableStatus,
  backoffMs,
};
