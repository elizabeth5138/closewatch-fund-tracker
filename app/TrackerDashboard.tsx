"use client";

import { useMemo, useState } from "react";
import type { DashboardSnapshot } from "../lib/dashboard.ts";
import type { DashboardFund } from "../lib/demo-data.ts";

type Filter = "all" | "priced" | "attention";

function Change({ value }: { value: string }) {
  const tone = value.startsWith("+")
    ? "positive"
    : value.startsWith("−") || value.startsWith("-")
      ? "negative"
      : "neutral";
  return <span className={`change change-${tone}`}>{value}</span>;
}

function MiniTrend({ fund }: { fund: DashboardFund }) {
  if (fund.sparkline.length < 2) {
    return <span className="trend-unavailable">Not enough history</span>;
  }
  const tone = fund.returns.oneMonth.startsWith("+")
    ? "trend-up"
    : fund.returns.oneMonth.startsWith("−") || fund.returns.oneMonth.startsWith("-")
      ? "trend-down"
      : "trend-neutral";
  return (
    <div
      className={`mini-trend ${tone}`}
      aria-label={`${fund.ticker}, last ${fund.sparkline.length} stored observations; one-month price return ${fund.returns.oneMonth}`}
      role="img"
    >
      {fund.sparkline.map((top, index) => (
        <i
          key={`${fund.id}-${index}`}
          style={{ height: `${Math.max(5, 54 - top)}px` }}
        />
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: DashboardFund["status"] }) {
  const labels: Record<DashboardFund["status"], string> = {
    priced: "Priced",
    pending: "Pending",
    missing: "Missing",
    no_trade: "No trade",
    suspended: "Suspended",
    not_listed: "Not listed",
  };
  return (
    <span className={`status-badge status-${status}`}>
      <span aria-hidden="true" />
      {labels[status]}
    </span>
  );
}

function ModeNotice({ snapshot }: { snapshot: DashboardSnapshot }) {
  if (snapshot.mode === "live") return null;
  const content = {
    illustrative: {
      tag: "PREVIEW",
      text: "Every value below is an illustrative fixture. Preview mode is explicit and stores no live market data.",
    },
    setup: {
      tag: "SETUP",
      text: "The database is ready, but no completed market session has been ingested yet. No sample prices are being substituted.",
    },
    unavailable: {
      tag: "INCIDENT",
      text: "Live records could not be loaded. Closewatch is showing no prices rather than replacing them with plausible fixtures.",
    },
  }[snapshot.mode];
  return (
    <aside className={`demo-banner notice-${snapshot.mode}`} aria-label={`${content.tag} notice`}>
      <span className="demo-tag">{content.tag}</span>
      <p>{content.text}</p>
      <a href="#methodology">See trust rules</a>
    </aside>
  );
}

function SampleTag({ show }: { show: boolean }) {
  return show ? <span className="sample-tag">SAMPLE</span> : null;
}

function MobileFundCard({ fund, sample }: { fund: DashboardFund; sample: boolean }) {
  return (
    <article className="mobile-fund-card">
      <div className="mobile-fund-head">
        <div className="fund-cell">
          <span className="ticker-box">{fund.ticker}</span>
          <div>
            <strong>{fund.name}</strong>
            <span>{fund.kind} · US · USD</span>
          </div>
        </div>
        <SampleTag show={sample} />
      </div>
      <div className="mobile-price-line">
        <div>
          <span>Previous close</span>
          <strong>{fund.price}</strong>
          <small>{fund.sessionDate}</small>
        </div>
        <StatusBadge status={fund.status} />
      </div>
      <p className="mobile-returns-label">Price returns</p>
      <dl className="mobile-returns">
        {[
          ["1D", fund.returns.oneDay],
          ["1W", fund.returns.oneWeek],
          ["1M", fund.returns.oneMonth],
          ["YTD", fund.returns.ytd],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd><Change value={value} /></dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export default function TrackerDashboard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [filter, setFilter] = useState<Filter>("all");
  const isLive = snapshot.mode === "live";
  const isSample = snapshot.mode === "illustrative";

  const visibleFunds = useMemo(() => {
    if (filter === "priced") return snapshot.funds.filter((fund) => fund.status === "priced");
    if (filter === "attention") return snapshot.funds.filter((fund) => fund.status !== "priced");
    return snapshot.funds;
  }, [filter, snapshot.funds]);

  const pricedCount = snapshot.funds.filter((fund) => fund.status === "priced").length;
  const attentionCount = snapshot.funds.length - pricedCount;
  const metricValue = (value: number) => isLive ? `${value}%` : "—";

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Closewatch home">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span>CLOSEWATCH</span>
        </a>
        <span className="scope-label">US-listed · USD · Price return</span>
      </header>

      <div className="page-shell" id="top">
        <section className="hero-row">
          <div>
            <p className="eyebrow">Singapore morning close monitor</p>
            <h1>Every close, accounted for.</h1>
            <p className="hero-copy">
              One dependable view of the latest US fund close—with pipeline
              failures separated from real market events.
            </p>
          </div>
          <div className={`run-state run-${snapshot.pipelineState}`} aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            <div>
              <strong>{snapshot.pipelineLabel}</strong>
              <span>{snapshot.pipelineDetail}</span>
            </div>
          </div>
        </section>

        <ModeNotice snapshot={snapshot} />

        <section className="metrics-grid" aria-label="Pipeline overview">
          <article className="metric-card metric-primary">
            <div className="metric-label">
              <span>Pipeline health</span>
              <span className="metric-info" aria-hidden="true">i</span>
              <span className="sr-only">Expected records without missing or pending states.</span>
            </div>
            <div className="metric-line">
              <strong>{metricValue(snapshot.resolvedPercent)}</strong>
              <span className={isLive && snapshot.resolvedPercent === 100 ? "metric-good" : ""}>
                {isLive ? "Latest session" : "No live denominator"}
              </span>
            </div>
            <p>Expected records without pipeline defects</p>
            <div className="progress-track" aria-hidden="true">
              <span style={{ width: isLive ? `${snapshot.resolvedPercent}%` : "0%" }} />
            </div>
          </article>

          <article className="metric-card">
            <div className="metric-label">
              <span>Data completeness</span>
              <span className="metric-info" aria-hidden="true">i</span>
              <span className="sr-only">Expected records with a genuine published close.</span>
            </div>
            <div className="metric-line">
              <strong>{metricValue(snapshot.pricedPercent)}</strong>
              <span>{isLive ? `${pricedCount}/${snapshot.funds.length} priced` : "No live denominator"}</span>
            </div>
            <p>Genuine closes captured for the same session</p>
            <div className="progress-track progress-indigo" aria-hidden="true">
              <span style={{ width: isLive ? `${snapshot.pricedPercent}%` : "0%" }} />
            </div>
          </article>

          <article className="metric-card">
            <div className="metric-label">
              <span>20-session success run</span>
              <span className="run-count">{snapshot.reliabilitySessions} / 20</span>
            </div>
            <div className="metric-line">
              <strong>{snapshot.reliabilitySessions}</strong>
              <span>sessions</span>
            </div>
            <p>Scheduled, gap-free, ≥99% priced within 24 hours</p>
            <div className="session-dots" aria-label={`${snapshot.reliabilitySessions} of 20 qualifying sessions`}>
              {Array.from({ length: 20 }, (_, index) => (
                <i className={index < snapshot.reliabilitySessions ? "complete" : ""} key={index} />
              ))}
            </div>
          </article>
        </section>

        <section className="watchlist-section" aria-labelledby="watchlist-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your watchlist</p>
              <h2 id="watchlist-title">Previous close</h2>
            </div>
            <div className="as-of">
              <span>{isSample ? "Illustrative as-of date" : "As of previous close"}</span>
              <strong>{snapshot.latestSession}</strong>
            </div>
          </div>

          <div className="filter-row" role="group" aria-label="Filter watchlist">
            {[
              ["all", "All", snapshot.funds.length],
              ["priced", "Priced", pricedCount],
              ["attention", "Other states", attentionCount],
            ].map(([value, label, count]) => (
              <button
                aria-pressed={filter === value}
                className={filter === value ? "active" : ""}
                disabled={snapshot.funds.length === 0}
                key={value}
                onClick={() => setFilter(value as Filter)}
                type="button"
              >
                {label} <span>{count}</span>
              </button>
            ))}
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            Showing {visibleFunds.length} fund{visibleFunds.length === 1 ? "" : "s"}.
          </p>

          <div className="table-wrap">
            <table>
              <caption className="sr-only">
                {isSample ? "Illustrative sample fund prices" : "Fund prices for one common expected session"}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fund</th>
                  <th scope="col">Previous close</th>
                  <th scope="col">Last observations</th>
                  <th scope="col">1D</th>
                  <th scope="col">1W</th>
                  <th scope="col">1M</th>
                  <th scope="col">YTD</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleFunds.length === 0 ? (
                  <tr><td className="empty-table" colSpan={8}>No fund records to show.</td></tr>
                ) : visibleFunds.map((fund) => (
                  <tr key={fund.id}>
                    <td>
                      <div className="fund-cell">
                        <span className="ticker-box">{fund.ticker}</span>
                        <div>
                          <strong>{fund.name}</strong>
                          <span>{fund.kind} · US · USD</span>
                        </div>
                        <SampleTag show={isSample} />
                      </div>
                    </td>
                    <td>
                      <strong className="price">{fund.price}</strong>
                      <span className="price-date">{fund.sessionDate}</span>
                    </td>
                    <td><MiniTrend fund={fund} /></td>
                    <td><Change value={fund.returns.oneDay} /></td>
                    <td><Change value={fund.returns.oneWeek} /></td>
                    <td><Change value={fund.returns.oneMonth} /></td>
                    <td><Change value={fund.returns.ytd} /></td>
                    <td><StatusBadge status={fund.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mobile-fund-list">
            {visibleFunds.length === 0
              ? <p className="empty-mobile">No fund records to show.</p>
              : visibleFunds.map((fund) => <MobileFundCard fund={fund} sample={isSample} key={fund.id} />)}
          </div>
        </section>

        <section className="methodology" id="methodology">
          <div>
            <p className="eyebrow">Trust the gaps</p>
            <h2>Nothing is silently filled.</h2>
          </div>
          <div className="method-grid">
            <article>
              <span>01</span>
              <h3>Exact at rest</h3>
              <p>Prices are stored to six decimal places. No floating-point comparisons.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Revisions leave receipts</h3>
              <p>Every change advances an unbroken version chain with its full field diff.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Market events aren&apos;t defects</h3>
              <p>No-trade and listing-lifecycle states stay separate from a pipeline gap. Suspension detection is not automated in v1.</p>
            </article>
          </div>
        </section>

        <footer>
          <span>CLOSEWATCH · Research and monitoring only</span>
          <span>Price return, not total return · No trading or advice</span>
        </footer>
      </div>
    </main>
  );
}
