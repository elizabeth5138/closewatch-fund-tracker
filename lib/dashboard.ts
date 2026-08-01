export type FundStatus =
  | "priced"
  | "pending"
  | "missing"
  | "no_trade"
  | "suspended"
  | "not_listed";

export type DashboardFund = {
  id: string;
  ticker: string;
  name: string;
  kind: "ETF" | "CEF";
  price: string;
  sessionDate: string;
  status: FundStatus;
  returns: { oneDay: string; oneWeek: string; oneMonth: string; ytd: string };
  sparkline: number[];
};

export type DashboardSnapshot = {
  pipelineState: "healthy" | "attention";
  pipelineLabel: string;
  pipelineDetail: string;
  funds: DashboardFund[];
  expectedCount: number;
  resolvedPercent: number;
  pricedPercent: number;
  latestSession: string;
  lastUpdated: string;
  reliabilitySessions: number;
  source: string;
};

type MarketFund = {
  id: string;
  ticker: string;
  name: string;
  kind: "ETF" | "CEF";
  price: string | null;
  sessionDate: string;
  status: FundStatus;
  returns: {
    oneDay: string | null;
    oneWeek: string | null;
    oneMonth: string | null;
    ytd: string | null;
  };
  sparkline: string[];
};

export type MarketSnapshot = {
  generatedAt: string;
  marketSession: string;
  source: string;
  pipeline: {
    state: "healthy" | "attention";
    label: string;
    detail: string;
    expected: number;
    resolvedPercent: number;
    pricedPercent: number;
    successRun: number;
  };
  funds: MarketFund[];
};

function prettyPrice(price: string | null): string {
  if (!price) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(price));
}

function prettyDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function prettyRunTime(value: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Singapore",
    timeZoneName: "short",
  }).format(new Date(value));
}

function sparklineFromPrices(prices: string[]): number[] {
  if (prices.length < 2) return [];
  const numeric = prices.map(Number);
  const low = Math.min(...numeric);
  const high = Math.max(...numeric);
  const range = high - low || 1;
  return numeric.map((value) => 48 - Math.round(((value - low) / range) * 30));
}

function displayReturn(value: string | null): string {
  return value ?? "—";
}

export function dashboardFromMarketData(data: MarketSnapshot): DashboardSnapshot {
  return {
    pipelineState: data.pipeline.state,
    pipelineLabel: data.pipeline.label,
    pipelineDetail: `${data.pipeline.detail} · updated ${prettyRunTime(data.generatedAt)}`,
    expectedCount: data.pipeline.expected,
    funds: data.funds.map((fund) => ({
      id: fund.id,
      ticker: fund.ticker,
      name: fund.name,
      kind: fund.kind,
      price: prettyPrice(fund.price),
      sessionDate: prettyDate(fund.sessionDate),
      status: fund.status,
      returns: {
        oneDay: displayReturn(fund.returns.oneDay),
        oneWeek: displayReturn(fund.returns.oneWeek),
        oneMonth: displayReturn(fund.returns.oneMonth),
        ytd: displayReturn(fund.returns.ytd),
      },
      sparkline: sparklineFromPrices(fund.sparkline),
    })),
    resolvedPercent: data.pipeline.resolvedPercent,
    pricedPercent: data.pipeline.pricedPercent,
    latestSession: prettyDate(data.marketSession),
    lastUpdated: prettyRunTime(data.generatedAt),
    reliabilitySessions: data.pipeline.successRun,
    source: data.source,
  };
}
