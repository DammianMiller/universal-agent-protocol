export async function fetchWithRetry(
  url: string,
  retryConfig?: { maxRetries: number; backoffMs: number }
): Promise<Response> {
  const config = {
    maxRetries: retryConfig?.maxRetries ?? 3,
    backoffMs: retryConfig?.backoffMs ?? 1000,
  };
  let lastError: Error | null = null;
  let lastStatusCode: number | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = config.backoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response = await fetch(url);

      if (!response.ok) {
        lastStatusCode = response.status;
        const isRetryable =
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 429;

        if (isRetryable && attempt < config.maxRetries) {
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          continue;
        }

        const httpError = new Error(
          `HTTP error ${response.status}: ${response.statusText}`
        ) as Error & {
          url: string;
          attempts: number;
          statusCode?: number;
          lastError?: Error | null;
        };
        httpError.name = 'FetchRetryError';
        httpError.url = url;
        httpError.attempts = attempt + 1;
        httpError.statusCode = response.status;
        httpError.lastError = null;
        throw httpError;
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'FetchRetryError') {
        throw error;
      }

      if (error instanceof Error) {
        lastError = error;

        if (attempt < config.maxRetries) {
          continue;
        }
      }

      const finalError = new Error(
        `Fetch failed after ${attempt + 1} attempts: ${error instanceof Error ? error.message : String(error)}`
      ) as Error & {
        url: string;
        attempts: number;
        statusCode?: number;
        lastError?: Error | null;
      };
      finalError.name = 'FetchRetryError';
      finalError.url = url;
      finalError.attempts = attempt + 1;
      finalError.statusCode = lastStatusCode;
      finalError.lastError = lastError;
      throw finalError;
    }
  }

  const exhaustedError = new Error(
    `All ${config.maxRetries + 1} attempts failed for ${url}`
  ) as Error & {
    url: string;
    attempts: number;
    statusCode?: number;
    lastError?: Error | null;
  };
  exhaustedError.name = 'FetchRetryError';
  exhaustedError.url = url;
  exhaustedError.attempts = config.maxRetries + 1;
  exhaustedError.statusCode = lastStatusCode;
  exhaustedError.lastError = lastError;
  throw exhaustedError;
}
