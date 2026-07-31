import { statusAfterArrivalWindow, type CandidateObservation } from "./domain.ts";
import { barForSession, type PriceProvider, type ProviderBar } from "./provider.ts";
import {
  applyObservation,
  getDailyRecord,
  getTrackedFunds,
  seedWatchlist,
  type TrackedFund,
} from "./store.ts";

export const RECONCILIATION_SESSIONS = 7;
export const INGESTION_LEASE_SECONDS = 15 * 60;
export const INGESTION_COOLDOWN_SECONDS = 60;

export class IngestionBusyError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = INGESTION_COOLDOWN_SECONDS) {
    super("Another ingestion run is active or the cooldown has not elapsed.");
    this.name = "IngestionBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class IngestionLeaseLostError extends Error {
  constructor() {
    super("Ingestion lease ownership was lost.");
    this.name = "IngestionLeaseLostError";
  }
}

export type IngestionSummary = {
  runId: string;
  sessionDate: string | null;
  reconciledSessions: string[];
  expected: number;
  created: number;
  revised: number;
  unchanged: number;
  failed: Array<{ ticker: string; reason: string }>;
};

function calendarAgeDays(newer: string, older: string): number {
  return Math.floor(
    (Date.parse(`${newer}T00:00:00Z`) - Date.parse(`${older}T00:00:00Z`)) /
      86_400_000,
  );
}

function newYorkOffsetHours(sessionDate: string): number {
  const noonUtc = new Date(`${sessionDate}T12:00:00Z`);
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(noonUtc).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zoneName ?? "");
  if (!match) throw new Error(`Unable to resolve New York offset for ${sessionDate}`);
  const magnitude = Number(match[2]) + Number(match[3] ?? 0) / 60;
  return match[1] === "-" ? -magnitude : magnitude;
}

function sessionCloseTime(sessionDate: string): number {
  const [year, month, day] = sessionDate.split("-").map(Number);
  return Date.UTC(
    year,
    month - 1,
    day,
    16 - newYorkOffsetHours(sessionDate),
  );
}

function isCompletedReferenceSession(sessionDate: string, now: Date): boolean {
  return isIsoDate(sessionDate) && sessionCloseTime(sessionDate) <= now.getTime();
}

function mostRecentExpectedWeekdayReference(now: Date): string {
  const newYorkToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const cursor = new Date(`${newYorkToday}T00:00:00Z`);
  for (let checked = 0; checked < 8; checked += 1) {
    const sessionDate = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (
      weekday >= 1 &&
      weekday <= 5 &&
      sessionCloseTime(sessionDate) <= now.getTime()
    ) {
      return sessionDate;
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  throw new Error("Unable to determine reference freshness boundary.");
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

async function startRun(
  db: D1Database,
  runId: string,
  source: string,
  startedAt: string,
  triggerKind: "scheduled" | "manual",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ingestion_run (id, source, trigger_kind, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .bind(runId, source, triggerKind, startedAt)
    .run();
}

async function acquireLease(
  db: D1Database,
  runId: string,
  now: Date,
): Promise<void> {
  const staleBefore = new Date(
    now.getTime() - INGESTION_LEASE_SECONDS * 1000,
  ).toISOString();
  const cooldownBefore = new Date(
    now.getTime() - INGESTION_COOLDOWN_SECONDS * 1000,
  ).toISOString();
  await db.prepare(
    `UPDATE ingestion_lease SET run_id = ?, acquired_at = ?
     WHERE id = 1 AND (
       (run_id IS NULL AND (released_at IS NULL OR released_at <= ?)) OR
       (run_id IS NOT NULL AND acquired_at < ?)
     )`,
  ).bind(runId, now.toISOString(), cooldownBefore, staleBefore).run();
  const lease = await db.prepare(
    "SELECT run_id AS runId FROM ingestion_lease WHERE id = 1",
  ).first<{ runId: string | null }>();
  if (lease?.runId !== runId) throw new IngestionBusyError();

  await db.prepare(
    `UPDATE ingestion_run SET
      status = 'failed', finished_at = ?, failure_count = failure_count + 1
     WHERE status = 'running' AND started_at < ?`,
  ).bind(now.toISOString(), staleBefore).run();
}

async function releaseLease(
  db: D1Database,
  runId: string,
  releasedAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE ingestion_lease
     SET run_id = NULL, acquired_at = NULL, released_at = ?
     WHERE id = 1 AND run_id = ?`,
  ).bind(releasedAt, runId).run();
}

async function refreshLease(
  db: D1Database,
  runId: string,
  heartbeatAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE ingestion_lease SET acquired_at = ?
     WHERE id = 1 AND run_id = ?`,
  ).bind(heartbeatAt, runId).run();
  const lease = await db.prepare(
    "SELECT run_id AS runId FROM ingestion_lease WHERE id = 1",
  ).first<{ runId: string | null }>();
  if (lease?.runId !== runId) throw new IngestionLeaseLostError();
}

async function recordFetch(
  db: D1Database,
  runId: string,
  ticker: string,
  source: string,
  attemptedAt: string,
  outcome: "succeeded" | "failed",
  detail: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fetch_attempt
        (id, run_id, ticker, source, attempted_at, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      runId,
      ticker,
      source,
      attemptedAt,
      outcome,
      detail,
    )
    .run();
}

async function recordExpectations(
  db: D1Database,
  runId: string,
  funds: TrackedFund[],
  sessions: string[],
): Promise<void> {
  const statements = funds.flatMap((fund) =>
    sessions.map((sessionDate) =>
      db.prepare(
        `INSERT INTO ingestion_expectation (run_id, session_date, fund_id)
         VALUES (?, ?, ?)`,
      ).bind(runId, sessionDate, fund.fundId),
    ),
  );
  if (statements.length > 0) await db.batch(statements);
}

async function recordReferenceSessions(
  db: D1Database,
  source: string,
  observedAt: string,
  sessions: string[],
): Promise<void> {
  for (let offset = 0; offset < sessions.length; offset += 50) {
    const chunk = sessions.slice(offset, offset + 50);
    await db.batch(chunk.map((sessionDate) =>
      db.prepare(
        `INSERT OR IGNORE INTO reference_session
          (session_date, first_observed_at, source)
         VALUES (?, ?, ?)`,
      ).bind(sessionDate, observedAt, source),
    ));
  }
}

async function finishRun(
  db: D1Database,
  summary: IngestionSummary,
  finishedAt: string,
  forcedStatus?: "failed",
): Promise<void> {
  const stateCounts = await db.prepare(
    `SELECT
       SUM(CASE WHEN dr.status <> 'pending' THEN 1 ELSE 0 END) AS resolvedCount,
       SUM(CASE WHEN dr.status = 'missing' THEN 1 ELSE 0 END) AS missingCount
     FROM ingestion_expectation ie
     JOIN daily_record dr
       ON dr.fund_id = ie.fund_id AND dr.session_date = ie.session_date
     WHERE ie.run_id = ?`,
  ).bind(summary.runId).first<{
    resolvedCount: number | null;
    missingCount: number | null;
  }>();
  const resolvedCount = stateCounts?.resolvedCount ?? 0;
  const missingCount = stateCounts?.missingCount ?? 0;
  const status = forcedStatus ?? (
    summary.failed.length > 0 || missingCount > 0 ? "partial" : "succeeded"
  );
  await db
    .prepare(
      `UPDATE ingestion_run SET
        finished_at = ?,
        status = ?,
        latest_session = ?,
        expected_count = ?,
        resolved_count = ?,
        failure_count = ?
       WHERE id = ?`,
    )
    .bind(
      finishedAt,
      status,
      summary.sessionDate,
      summary.expected,
      resolvedCount,
      summary.failed.length,
      summary.runId,
    )
    .run();
}

export async function recordFailedIngestionRun(
  db: D1Database,
  source: string,
  reason: string,
  now = new Date(),
  triggerKind: "scheduled" | "manual" = "scheduled",
): Promise<string> {
  const runId = crypto.randomUUID();
  const timestamp = now.toISOString();
  await acquireLease(db, runId, now);
  try {
    await startRun(db, runId, source, timestamp, triggerKind);
    const summary: IngestionSummary = {
      runId,
      sessionDate: null,
      reconciledSessions: [],
      expected: 0,
      created: 0,
      revised: 0,
      unchanged: 0,
      failed: [{ ticker: "system", reason }],
    };
    await finishRun(db, summary, timestamp, "failed");
    return runId;
  } finally {
    await releaseLease(db, runId, timestamp);
  }
}

function previousBar(series: ProviderBar[], sessionDate: string): ProviderBar | null {
  return series.find((bar) => bar.sessionDate < sessionDate) ?? null;
}

function absenceCandidate(
  fund: TrackedFund,
  sessionDate: string,
  source: string,
  now: Date,
): CandidateObservation {
  if (fund.inceptionDate && sessionDate < fund.inceptionDate) {
    return {
      fundId: fund.fundId,
      sessionDate,
      status: "not_listed",
      price: null,
      volume: null,
      source,
    };
  }
  if (fund.delistedDate && sessionDate > fund.delistedDate) {
    return {
      fundId: fund.fundId,
      sessionDate,
      status: "not_listed",
      price: null,
      volume: null,
      source,
    };
  }
  return {
    fundId: fund.fundId,
    sessionDate,
    status: statusAfterArrivalWindow(false, now, sessionDate) ?? "pending",
    price: null,
    volume: null,
    source,
  };
}

function observationCandidate(
  fund: TrackedFund,
  series: ProviderBar[],
  sessionDate: string,
  source: string,
  now: Date,
): { candidate: CandidateObservation; anomaly?: string } {
  if (
    (fund.inceptionDate && sessionDate < fund.inceptionDate) ||
    (fund.delistedDate && sessionDate > fund.delistedDate)
  ) {
    return { candidate: absenceCandidate(fund, sessionDate, source, now) };
  }

  const bar = barForSession(series, sessionDate);
  if (!bar) {
    return { candidate: absenceCandidate(fund, sessionDate, source, now) };
  }

  if (bar.volume === "0") {
    const previous = previousBar(series, sessionDate);
    if (previous && previous.close === bar.close) {
      return {
        candidate: {
          fundId: fund.fundId,
          sessionDate,
          status: "no_trade",
          price: bar.close,
          volume: "0",
          source,
        },
      };
    }
    return {
      candidate: absenceCandidate(fund, sessionDate, source, now),
      anomaly: `Zero volume with ${previous ? "a changed close" : "no prior close"} on ${sessionDate}.`,
    };
  }

  return {
    candidate: {
      fundId: fund.fundId,
      sessionDate,
      status: "priced",
      price: bar.close,
      volume: bar.volume,
      source,
    },
  };
}

function tickerForSession(fund: TrackedFund, sessionDate: string): string | null {
  return fund.tickers.find(
    (assignment) =>
      assignment.validFrom <= sessionDate &&
      (assignment.validTo === null || assignment.validTo >= sessionDate),
  )?.ticker ?? null;
}

function isInsideListedLifetime(fund: TrackedFund, sessionDate: string): boolean {
  return !(
    (fund.inceptionDate && sessionDate < fund.inceptionDate) ||
    (fund.delistedDate && sessionDate > fund.delistedDate)
  );
}

export async function runDailyIngestion(
  db: D1Database,
  provider: PriceProvider,
  now = new Date(),
  triggerKind: "scheduled" | "manual" = "manual",
): Promise<IngestionSummary> {
  const wallClockStartedAt = Date.now();
  const occurredAt = () => new Date(
    now.getTime() + (Date.now() - wallClockStartedAt),
  ).toISOString();
  const startedAt = occurredAt();
  const runId = crypto.randomUUID();
  await acquireLease(db, runId, now);
  const summary: IngestionSummary = {
    runId,
    sessionDate: null,
    reconciledSessions: [],
    expected: 0,
    created: 0,
    revised: 0,
    unchanged: 0,
    failed: [],
  };
  let runStarted = false;
  let runFinished = false;

  try {
    await seedWatchlist(db);
    await startRun(db, runId, provider.source, startedAt, triggerKind);
    runStarted = true;

    let referenceSeries: ProviderBar[];
    let referenceObservedAt: string;
    try {
      await refreshLease(db, runId, occurredAt());
      referenceSeries = await provider.dailySeries("SPY");
      referenceObservedAt = occurredAt();
      await refreshLease(db, runId, referenceObservedAt);
      await recordFetch(
        db,
        runId,
        "SPY",
        provider.source,
        referenceObservedAt,
        "succeeded",
        null,
      );
    } catch (error) {
      if (error instanceof IngestionLeaseLostError) throw error;
      const reason = error instanceof Error ? error.message : "Reference fetch failed";
      summary.failed.push({ ticker: "SPY", reason });
      await recordFetch(
        db,
        runId,
        "SPY",
        provider.source,
        occurredAt(),
        "failed",
        reason,
      );
      throw error;
    }

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const completedReferenceSessions = referenceSeries
      .map((bar) => bar.sessionDate)
      .filter((sessionDate) => isCompletedReferenceSession(sessionDate, now))
      .filter((sessionDate, index, all) => all.indexOf(sessionDate) === index)
      .sort((a, b) => b.localeCompare(a));
    const latestReferenceSession = completedReferenceSessions[0];

    if (
      !latestReferenceSession ||
      calendarAgeDays(today, latestReferenceSession) > 7
    ) {
      const reason = latestReferenceSession
        ? `Reference series is stale at ${latestReferenceSession}.`
        : "No completed reference session found.";
      summary.failed.push({ ticker: "SPY", reason });
      throw new Error(reason);
    }
    const freshnessBoundary = mostRecentExpectedWeekdayReference(now);
    if (latestReferenceSession < freshnessBoundary) {
      const reason = `Reference series has not advanced to the latest ordinary weekday close (${freshnessBoundary}); newest bar is ${latestReferenceSession}. Treat this as a possible market closure or provider delay, not a healthy run.`;
      summary.failed.push({ ticker: "SPY", reason });
      throw new Error(reason);
    }
    const minimumHistoryDepth = provider.minimumHistoryDepth ?? 1;
    if (completedReferenceSessions.length < minimumHistoryDepth) {
      const reason = `Reference response contained ${completedReferenceSessions.length} completed session${completedReferenceSessions.length === 1 ? "" : "s"}; expected at least ${minimumHistoryDepth}.`;
      summary.failed.push({ ticker: "SPY", reason });
      throw new Error(reason);
    }
    await recordReferenceSessions(
      db,
      provider.source,
      referenceObservedAt,
      completedReferenceSessions,
    );

    const sessions = completedReferenceSessions.slice(0, RECONCILIATION_SESSIONS);
    summary.sessionDate = latestReferenceSession;
    summary.reconciledSessions = sessions;
    const previouslyExpected = await db.prepare(
      `SELECT DISTINCT session_date AS sessionDate
       FROM ingestion_expectation
       WHERE session_date <= ?
       ORDER BY session_date DESC LIMIT ?`,
    ).bind(latestReferenceSession, RECONCILIATION_SESSIONS).all<{
      sessionDate: string;
    }>();
    const omittedReferenceSessions = previouslyExpected.results
      .map((row) => row.sessionDate)
      .filter((sessionDate) => !completedReferenceSessions.includes(sessionDate));
    if (omittedReferenceSessions.length > 0) {
      summary.failed.push({
        ticker: "SPY",
        reason: `Reference response omitted known session${omittedReferenceSessions.length === 1 ? "" : "s"}: ${omittedReferenceSessions.join(", ")}.`,
      });
    }

    const funds = await getTrackedFunds(db);
    summary.expected = funds.length * sessions.length;
    await recordExpectations(db, runId, funds, sessions);

    const requiredTickers = new Set<string>();
    for (const fund of funds) {
      for (const sessionDate of sessions) {
        if (!isInsideListedLifetime(fund, sessionDate)) continue;
        const ticker = tickerForSession(fund, sessionDate);
        if (ticker) requiredTickers.add(ticker);
      }
    }
    const seriesByTicker = new Map<string, {
      bars: ProviderBar[] | null;
      observedAt: string;
    }>([
      ["SPY", { bars: referenceSeries, observedAt: referenceObservedAt }],
    ]);
    for (const ticker of requiredTickers) {
      if (ticker === "SPY") continue;
      try {
        await refreshLease(db, runId, occurredAt());
        const series = await provider.dailySeries(ticker);
        const observedAt = occurredAt();
        await refreshLease(db, runId, observedAt);
        seriesByTicker.set(ticker, { bars: series, observedAt });
        await recordFetch(
          db,
          runId,
          ticker,
          provider.source,
          observedAt,
          "succeeded",
          null,
        );
      } catch (error) {
        if (error instanceof IngestionLeaseLostError) throw error;
        const reason = error instanceof Error ? error.message : "Unknown fetch error";
        const observedAt = occurredAt();
        seriesByTicker.set(ticker, { bars: null, observedAt });
        summary.failed.push({ ticker, reason });
        await recordFetch(
          db,
          runId,
          ticker,
          provider.source,
          observedAt,
          "failed",
          reason,
        );
      }
    }

    for (const fund of funds) {
      for (const sessionDate of sessions) {
        const ticker = tickerForSession(fund, sessionDate);
        const seriesObservation = ticker ? seriesByTicker.get(ticker) : undefined;
        const series = seriesObservation?.bars ?? null;
        if (!ticker && isInsideListedLifetime(fund, sessionDate)) {
          summary.failed.push({
            ticker: fund.fundId,
            reason: `No ticker assignment is valid on ${sessionDate}.`,
          });
        }
        const { candidate, anomaly } = series
          ? observationCandidate(
              fund,
              series,
              sessionDate,
              provider.source,
              now,
            )
          : { candidate: absenceCandidate(fund, sessionDate, provider.source, now) };

        if (anomaly) {
          summary.failed.push({ ticker: ticker ?? fund.fundId, reason: anomaly });
        }

        if (candidate.status === "pending" || candidate.status === "missing") {
          const current = await getDailyRecord(db, fund.fundId, sessionDate);
          if (current && current.status !== "pending" && current.status !== "missing") {
            if (series && !barForSession(series, sessionDate)) {
              summary.failed.push({
                ticker: ticker ?? fund.fundId,
                reason: `Provider omitted previously resolved session ${sessionDate}; stored value preserved.`,
              });
            }
            summary.unchanged += 1;
            continue;
          }
        }

        try {
          await refreshLease(db, runId, occurredAt());
          const result = await applyObservation(
            db,
            candidate,
            seriesObservation?.observedAt ?? occurredAt(),
          );
          summary[result] += 1;
        } catch (error) {
          if (error instanceof IngestionLeaseLostError) throw error;
          summary.failed.push({
            ticker: ticker ?? fund.fundId,
            reason: error instanceof Error ? error.message : "Observation write failed",
          });
        }
      }
    }

    await finishRun(db, summary, occurredAt());
    runFinished = true;
    return summary;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unexpected ingestion failure";
    if (!summary.failed.some((failure) => failure.reason === reason)) {
      summary.failed.push({ ticker: "system", reason });
    }
    if (runStarted && !runFinished) {
      await finishRun(db, summary, occurredAt(), "failed");
      runFinished = true;
    }
    throw error;
  } finally {
    try {
      await releaseLease(db, runId, occurredAt());
    } catch (error) {
      console.error("Failed to release ingestion lease", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
