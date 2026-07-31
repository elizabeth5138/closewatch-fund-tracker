import { canonicalizePrice, canonicalizeVolume } from "./domain.ts";

export type ProviderBar = {
  sessionDate: string;
  close: string;
  volume: string;
};

export interface PriceProvider {
  readonly source: string;
  readonly minimumHistoryDepth?: number;
  dailySeries(ticker: string): Promise<ProviderBar[]>;
}

type AlphaVantagePayload = {
  "Time Series (Daily)"?: Record<
    string,
    {
      "4. close": string;
      "5. volume": string;
    }
  >;
  Note?: string;
  Information?: string;
  "Error Message"?: string;
};

export class AlphaVantageProvider implements PriceProvider {
  readonly source = "alpha_vantage";
  readonly minimumHistoryDepth = 7;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    fetcher: typeof fetch = fetch,
    options: {
      maxAttempts?: number;
      retryDelayMs?: number;
      timeoutMs?: number;
    } = {},
  ) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async dailySeries(ticker: string): Promise<ProviderBar[]> {
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "TIME_SERIES_DAILY");
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("outputsize", "compact");
    url.searchParams.set("apikey", this.apiKey);

    let response: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        response = await this.fetcher(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) break;
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          lastError = new Error(
            `Provider HTTP 429${retryAfter ? `; retry after ${retryAfter}` : ""}`,
          );
          break;
        }
        if (response.status < 500) {
          throw new Error(`Provider HTTP ${response.status}`);
        }
        lastError = new Error(`Provider HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < this.maxAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * attempt),
        );
      }
    }
    if (!response?.ok) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Provider request failed.");
    }

    const payload = (await response.json()) as AlphaVantagePayload;
    const series = payload["Time Series (Daily)"];
    if (!series) {
      const message =
        payload["Error Message"] ?? payload.Note ?? payload.Information ?? "Daily series missing";
      throw new Error(`Alpha Vantage: ${message}`);
    }

    return Object.entries(series)
      .map(([sessionDate, value]) => {
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) ||
          new Date(`${sessionDate}T00:00:00Z`).toISOString().slice(0, 10) !==
            sessionDate
        ) {
          throw new Error(`Alpha Vantage returned an invalid session date: ${sessionDate}`);
        }
        if (
          !value ||
          typeof value["4. close"] !== "string" ||
          typeof value["5. volume"] !== "string"
        ) {
          throw new Error(`Alpha Vantage returned malformed OHLCV for ${sessionDate}`);
        }
        return {
          sessionDate,
          close: canonicalizePrice(value["4. close"]),
          volume: canonicalizeVolume(value["5. volume"]),
        };
      })
      .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));
  }
}

export function barForSession(
  series: ProviderBar[],
  sessionDate: string,
): ProviderBar | null {
  return series.find((bar) => bar.sessionDate === sessionDate) ?? null;
}
