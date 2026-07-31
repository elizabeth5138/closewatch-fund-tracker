import { dashboardFunds, type DashboardFund } from "./demo-data.ts";
import {
  ARRIVAL_HOUR_UTC,
  canonicalizePrice,
  formatPriceReturn,
} from "./domain.ts";

type LatestRun = {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  triggerKind: "scheduled" | "manual";
  startedAt: string;
  finishedAt: string | null;
  latestSession: string | null;
  failureCount: number;
};

type FundRow = {
  id: string;
  ticker: string;
  name: string;
  kind: "ETF" | "CEF";
  sessionDate: string;
  status: DashboardFund["status"] | null;
  price: string | null;
  oneDayPrice: string | null;
  oneWeekPrice: string | null;
  oneMonthPrice: string | null;
  ytdPrice: string | null;
};

export type DashboardMode = "live" | "illustrative" | "setup" | "unavailable";
export type PipelineState = "healthy" | "attention" | "setup" | "unavailable";

export type DashboardSnapshot = {
  mode: DashboardMode;
  pipelineState: PipelineState;
  pipelineLabel: string;
  pipelineDetail: string;
  funds: DashboardFund[];
  resolvedPercent: number;
  pricedPercent: number;
  latestSession: string;
  lastUpdated: string;
  reliabilitySessions: number;
};

export function hasNoPipelineGaps(
  activeFundCount: number,
  resolvedFundCount: number,
): boolean {
  return activeFundCount > 0 && activeFundCount === resolvedFundCount;
}

function prettyPrice(price: string): string {
  const canonical = canonicalizePrice(price);
  const scaled = BigInt(canonical.replace(".", ""));
  const cents = (scaled + 5_000n) / 10_000n;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function prettyDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function prettyRunTime(value: string | null): string {
  if (!value) return "No completed run";
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

function expectedScheduleInstants(from: Date, to: Date): Date[] {
  const instants: Date[] = [];
  const start = new Date(from);
  start.setUTCDate(start.getUTCDate() - 1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCDate(end.getUTCDate() + 1);
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) {
      instants.push(new Date(Date.UTC(
        cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 23, 15,
      )));
    }
    if (day >= 2 && day <= 6) {
      instants.push(new Date(Date.UTC(
        cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 9, 45,
      )));
    }
  }
  return instants.sort((a, b) => a.getTime() - b.getTime());
}

function isAutomationStale(lastRunAt: string | null, now: Date): boolean {
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  const graceCutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  return expectedScheduleInstants(last, now).some(
    (instant) => instant > last && instant <= graceCutoff,
  );
}

function captureDeadline(sessionDate: string): number {
  const [year, month, day] = sessionDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day + 1, ARRIVAL_HOUR_UTC);
}

async function reliabilityCount(db: D1Database): Promise<number> {
  const sessions = await db.prepare(
    `SELECT session_date AS sessionDate
     FROM reference_session
     ORDER BY session_date DESC LIMIT 20`,
  ).all<{ sessionDate: string }>();

  let count = 0;
  for (const { sessionDate } of sessions.results) {
    const deadlineIso = new Date(captureDeadline(sessionDate)).toISOString();
    const timelyRun = await db.prepare(
      `SELECT ir.id
       FROM ingestion_run ir
       JOIN ingestion_expectation ie ON ie.run_id = ir.id
       WHERE ir.trigger_kind = 'scheduled'
         AND ie.session_date = ?
         AND ir.started_at <= ?
         AND ir.status = 'succeeded'
         AND ir.failure_count = 0
       ORDER BY ir.started_at DESC LIMIT 1`,
    ).bind(sessionDate, deadlineIso).first<{ id: string }>();
    if (!timelyRun) break;

    const records = await db.prepare(
      `WITH expected AS (
         SELECT DISTINCT ie.fund_id
         FROM ingestion_expectation ie
         JOIN ingestion_run ir ON ir.id = ie.run_id
         WHERE ir.trigger_kind = 'scheduled'
           AND ie.session_date = ?
           AND ir.started_at <= ?
       )
       SELECT expected.fund_id AS fundId, dr.status,
        (
          SELECT MIN(re.detected_at) FROM record_event re
          WHERE re.fund_id = expected.fund_id
            AND re.session_date = ?
            AND json_extract(re.changes, '$.status.new') = 'priced'
        ) AS pricedAt
       FROM expected
       LEFT JOIN daily_record dr
         ON dr.fund_id = expected.fund_id AND dr.session_date = ?`,
    ).bind(
      sessionDate,
      deadlineIso,
      sessionDate,
      sessionDate,
    ).all<{ fundId: string; status: string | null; pricedAt: string | null }>();

    if (records.results.length === 0) break;
    if (records.results.some(
      (record) => !record.status || record.status === "missing" || record.status === "pending",
    )) break;
    const pricedRecords = records.results.filter((record) => record.status === "priced");
    if (pricedRecords.length / records.results.length < 0.99) break;
    const deadline = captureDeadline(sessionDate);
    if (pricedRecords.some((record) => !record.pricedAt || Date.parse(record.pricedAt) > deadline)) break;
    count += 1;
  }
  return count;
}

export async function loadDashboard(
  db: D1Database,
  now = new Date(),
): Promise<DashboardSnapshot> {
  const latestRun = await db.prepare(
    `SELECT id, status, trigger_kind AS triggerKind, started_at AS startedAt,
      finished_at AS finishedAt, latest_session AS latestSession,
      failure_count AS failureCount
     FROM ingestion_run ORDER BY started_at DESC LIMIT 1`,
  ).first<LatestRun>();
  const latestScheduledRun = await db.prepare(
    `SELECT id, status, trigger_kind AS triggerKind, started_at AS startedAt,
      finished_at AS finishedAt, latest_session AS latestSession,
      failure_count AS failureCount
     FROM ingestion_run
     WHERE trigger_kind = 'scheduled'
     ORDER BY started_at DESC LIMIT 1`,
  ).first<LatestRun>();
  const latestSessionRow = await db.prepare(
    `SELECT latest_session AS latestSession
     FROM ingestion_run
     WHERE latest_session IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`,
  ).first<{ latestSession: string }>();

  if (!latestSessionRow) return setupSnapshot(latestRun);
  const latestSession = latestSessionRow.latestSession;

  const latest = await db.prepare(
    `SELECT
      f.id, COALESCE(ft.ticker, 'UNASSIGNED') AS ticker,
      f.name, f.instrument_type AS kind,
      ? AS sessionDate, dr.status, dr.price,
      (
        SELECT p.price FROM daily_record p
        WHERE p.fund_id = f.id AND p.status IN ('priced', 'no_trade')
          AND p.session_date < ? AND p.price IS NOT NULL
        ORDER BY p.session_date DESC LIMIT 1
      ) AS oneDayPrice,
      (
        SELECT p.price FROM daily_record p
        WHERE p.fund_id = f.id AND p.status IN ('priced', 'no_trade')
          AND p.session_date <= date(?, '-7 day') AND p.price IS NOT NULL
        ORDER BY p.session_date DESC LIMIT 1
      ) AS oneWeekPrice,
      (
        SELECT p.price FROM daily_record p
        WHERE p.fund_id = f.id AND p.status IN ('priced', 'no_trade')
          AND p.session_date <= date(?, '-1 month') AND p.price IS NOT NULL
        ORDER BY p.session_date DESC LIMIT 1
      ) AS oneMonthPrice,
      (
        SELECT p.price FROM daily_record p
        WHERE p.fund_id = f.id AND p.status IN ('priced', 'no_trade')
          AND p.session_date < strftime('%Y-01-01', ?) AND p.price IS NOT NULL
        ORDER BY p.session_date DESC LIMIT 1
      ) AS ytdPrice
     FROM watchlist w
     JOIN fund f ON f.id = w.fund_id
     LEFT JOIN fund_ticker ft ON ft.fund_id = f.id AND ft.valid_to IS NULL
     LEFT JOIN daily_record dr ON dr.fund_id = f.id AND dr.session_date = ?
     WHERE w.active = 1
     ORDER BY ft.ticker`,
  ).bind(
    latestSession,
    latestSession,
    latestSession,
    latestSession,
    latestSession,
    latestSession,
  ).all<FundRow>();

  const funds: DashboardFund[] = [];
  for (const row of latest.results) {
    const historical = await db.prepare(
      `SELECT price FROM daily_record
       WHERE fund_id = ? AND price IS NOT NULL
         AND status IN ('priced', 'no_trade') AND session_date <= ?
       ORDER BY session_date DESC LIMIT 12`,
    ).bind(row.id, latestSession).all<{ price: string }>();
    const chronological = historical.results.map((item) => item.price).reverse();
    const price = row.price;
    funds.push({
      id: row.id,
      ticker: row.ticker,
      name: row.name,
      kind: row.kind,
      price: price ? prettyPrice(price) : "—",
      sessionDate: prettyDate(latestSession),
      status: row.status ?? "missing",
      returns: {
        oneDay: price ? formatPriceReturn(price, row.oneDayPrice) : "—",
        oneWeek: price ? formatPriceReturn(price, row.oneWeekPrice) : "—",
        oneMonth: price ? formatPriceReturn(price, row.oneMonthPrice) : "—",
        ytd: price ? formatPriceReturn(price, row.ytdPrice) : "—",
      },
      sparkline: sparklineFromPrices(chronological),
    });
  }

  const activeFundCount = funds.length;
  const priced = funds.filter((fund) => fund.status === "priced").length;
  const healthy = funds.filter(
    (fund) => fund.status !== "missing" && fund.status !== "pending",
  ).length;
  const unresolvedCount = activeFundCount - healthy;
  const resolvedPercent = activeFundCount ? Math.round((healthy / activeFundCount) * 100) : 0;
  const pricedPercent = activeFundCount ? Math.round((priced / activeFundCount) * 100) : 0;
  const stale = isAutomationStale(
    latestScheduledRun?.finishedAt ?? latestScheduledRun?.startedAt ?? null,
    now,
  );
  const runUnhealthy = !latestScheduledRun ||
    latestScheduledRun.status !== "succeeded" ||
    latestScheduledRun.failureCount > 0;
  const pipelineState: PipelineState =
    hasNoPipelineGaps(activeFundCount, healthy) && !runUnhealthy && !stale
      ? "healthy"
      : "attention";
  const pipelineLabel = pipelineState === "healthy" ? "Pipeline healthy" : "Pipeline needs attention";
  const pipelineDetail = stale
      ? `Expected scheduled run not observed · last ${prettyRunTime(latestScheduledRun?.finishedAt ?? latestScheduledRun?.startedAt ?? null)}`
    : runUnhealthy
      ? `Latest scheduled run ${latestScheduledRun?.status ?? "unavailable"} · ${prettyRunTime(latestScheduledRun?.finishedAt ?? latestScheduledRun?.startedAt ?? null)}`
      : unresolvedCount > 0
        ? `${unresolvedCount} expected record${unresolvedCount === 1 ? "" : "s"} missing or pending`
        : `Latest expected session · ${prettyDate(latestSession)}`;

  return {
    mode: "live",
    pipelineState,
    pipelineLabel,
    pipelineDetail,
    funds,
    resolvedPercent,
    pricedPercent,
    latestSession: prettyDate(latestSession),
    lastUpdated: prettyRunTime(latestRun?.finishedAt ?? latestRun?.startedAt ?? null),
    reliabilitySessions: pipelineState === "healthy"
      ? await reliabilityCount(db)
      : 0,
  };
}

export function illustrativeSnapshot(): DashboardSnapshot {
  return {
    mode: "illustrative",
    pipelineState: "setup",
    pipelineLabel: "Preview mode",
    pipelineDetail: "Illustrative rows · no live market data stored",
    funds: dashboardFunds,
    resolvedPercent: 0,
    pricedPercent: 0,
    latestSession: "Illustrative date · 29 Jul 2026",
    lastUpdated: "Illustrative fixtures",
    reliabilitySessions: 0,
  };
}

export function setupSnapshot(latestRun: LatestRun | null = null): DashboardSnapshot {
  return {
    mode: "setup",
    pipelineState: "setup",
    pipelineLabel: "Waiting for first ingestion",
    pipelineDetail: latestRun
      ? `Latest run ${latestRun.status} · ${prettyRunTime(latestRun.finishedAt ?? latestRun.startedAt)}`
      : "Database ready · no ingestion run recorded",
    funds: [],
    resolvedPercent: 0,
    pricedPercent: 0,
    latestSession: "No live session yet",
    lastUpdated: prettyRunTime(latestRun?.finishedAt ?? latestRun?.startedAt ?? null),
    reliabilitySessions: 0,
  };
}

export function unavailableSnapshot(): DashboardSnapshot {
  return {
    mode: "unavailable",
    pipelineState: "unavailable",
    pipelineLabel: "Data service unavailable",
    pipelineDetail: "Live records could not be loaded · fixtures were not substituted",
    funds: [],
    resolvedPercent: 0,
    pricedPercent: 0,
    latestSession: "Unavailable",
    lastUpdated: "Unavailable",
    reliabilitySessions: 0,
  };
}
