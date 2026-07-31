# Closewatch

Closewatch is a morning fund monitor for US-listed, USD-denominated ETFs and
closed-end funds. Its most important job is to account for every expected
previous-close record without confusing a market event with a pipeline defect.

The first screen shows:

- previous close;
- 1-day, 1-week, 1-month, and year-to-date **price return**;
- pipeline health: did every expected record reach a resolved state?;
- data completeness: how many expected records received a genuine close?;
- progress toward 20 consecutive unattended sessions with zero unexplained
  gaps.

It does not trade, connect to a brokerage, calculate cost basis, include
dividends, or give investment advice.

The hosted v1 is deployed as a **private site**. Closewatch has no separate
application account system, so it must not be changed to a shared/public
deployment without adding authentication first.

## The beginner mental model

- `app/` is the part people see in their browser.
- `lib/` contains the rules that make the tracker trustworthy.
- `db/` describes the permanent record-keeping structure.
- `worker/` receives web requests and the scheduled morning wake-up.
- `tests/` tries to break the rules before real data can.
- `drizzle/` contains the host-compatible table installation history.
- `.openai/hosting.json` tells the hosting platform that the site needs a
  database.

Git is the time machine for this folder. A commit is a named checkpoint.
GitHub is the online home where those Git checkpoints can be backed up and
reviewed. The beginner walkthrough in
[`docs/git-and-github.md`](docs/git-and-github.md) explains the everyday loop
and the secret-handling rules for this project.

## Trust model

### Exact prices

Prices enter the system as text, are normalized to exactly six decimal places,
and are compared without JavaScript floating-point arithmetic. `"100.12"` and
`"100.120000"` are the same stored price.

### Current record plus permanent receipts

`daily_record` contains the latest known state for one fund and trading
session. `record_event` contains an append-only receipt for each atomic
transition.

Creation is also an event:

```text
created: 0 → 1
revised: 1 → 2
revised: 2 → 3
```

The database rejects a receipt whose `from_version` does not match the current
record. It also rejects receipts that lie about an old value, direct mutations
that bypass the event log, and changes to historical receipts.

### States

| State | Meaning | Pipeline defect? |
| --- | --- | --- |
| `pending` | Inside the expected arrival window | No |
| `priced` | Genuine published close captured | No |
| `no_trade` | Zero volume and unchanged close | No |
| `suspended` | Confirmed suspension | No |
| `not_listed` | Before inception or after delisting | No |
| `missing` | Arrival window elapsed without an explainable value | Yes |

Closewatch never fills a database gap with yesterday's value. Presentation
code may choose a prior priced session for a comparison boundary, but the
stored series remains honest.

Automatic suspension detection is not implemented in v1 because the selected
price feed does not provide a dependable halt signal. Until a suspension is
confirmed by a separate trusted input, an unexplained absence remains
`pending` and then `missing`; the interface says this plainly.

### Bounded reconciliation

Every run revisits the seven most recent reference sessions. This catches
backfills and corrections without re-fetching the entire history forever.
Provider failures are persisted as fetch attempts, and expected rows are still
materialized so a failed request cannot disappear from the denominator.
The reference sessions themselves and each run's exact fund/session
expectations are also persisted. That prevents a later watchlist edit or long
outage from rewriting the 20-session history.

SPY is the US-session reference instrument. If its response is unavailable or
stale, the run fails explicitly; Closewatch does not reinterpret a provider
outage as a market holiday.

A small weekday freshness guard also refuses to call the pipeline healthy when
SPY has not advanced past the latest ordinary weekday close. It does not create
an expected fund session or pretend to be an exchange calendar: a real holiday,
unscheduled closure, and a late provider response all stay visibly unresolved
until the reference feed advances. That conservative ambiguity is preferable
to showing a false healthy state.

## Live-data setup

The deployed site needs two private runtime values:

```text
ALPHA_VANTAGE_API_KEY
INGEST_TOKEN
```

`ALPHA_VANTAGE_API_KEY` retrieves raw daily close and volume through the
documented `TIME_SERIES_DAILY` endpoint. Review the provider's current plan,
rate limits, and data terms before relying on it beyond a small personal
watchlist.

`INGEST_TOKEN` protects the manual ingestion endpoint. The endpoint fails
closed when the token is not configured. A database lease permits only one run
at a time and enforces a short cooldown; a stale lease is recovered as a failed
run rather than left permanently `running`.

Illustrative fixtures appear only when `PREVIEW_MODE=true`. Without a database
or when a live query fails, the interface shows an explicit unavailable state;
it never swaps in realistic-looking sample prices to hide an incident.

## Schedule

The worker declares two reconciliation schedules:

- `23:15 UTC` Monday–Friday (`07:15` Tuesday–Saturday in Singapore), the
  morning capture after each US close, including Friday's close on Saturday;
- `09:45 UTC` Tuesday–Saturday (`17:45` in Singapore), a same-day retry before
  the 24-hour completeness deadline.

The scheduled handler and protected `POST /api/ingest` endpoint call the same
ingestion function, but only scheduled runs can advance the unattended-session
counter.

After deployment, verify that the production host registered the schedule.
A handler existing in source code is not proof that the host will invoke it.

## Local development

Prerequisite: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The local address is normally `http://localhost:3000`.

Run the complete safety suite:

```bash
npm test
npm run lint
```

The integration tests use a temporary local D1 database. They cover exact
decimal handling, idempotent reruns, late backfills, revisions, overlapping
writers, provider failures, stale reference data, ticker-identity overlap,
append-only receipts, and direct-mutation rejection.

Generate a migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

The SQL migration must also be reviewed for database checks; schema generators
do not infer all of Closewatch's event-ledger invariants. The migration creates
the tables and checks that Sites can apply as one standard SQLite script. Before
either scheduled or manual ingestion can write, `ensureSchema` idempotently
installs the custom trigger-based integrity layer and singleton lease row. This
split is deliberate: the Sites migration parser does not accept trigger bodies,
while D1 prepared statements do. Dashboard reads never create tables, triggers,
or seed data.

## Success criterion

For 20 consecutive expected US trading sessions:

- 100% of expected records reach a resolved state;
- `missing = 0`;
- at least 99% resolve to `priced` within 24 hours of session close.

Operationally, Closewatch applies the stricter deadline of `10:00 UTC` on the
next calendar day. That stays inside 24 hours even on scheduled US half-days
without requiring a fragile exchange-calendar implementation.

The software can be built and tested immediately. This operational success
criterion can only be certified after 20 real sessions have elapsed.
