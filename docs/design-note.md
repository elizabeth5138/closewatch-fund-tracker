# Closewatch v1 design note

## Outcome

Every morning, without a prompt, retrieve and store the previous close for
each watched US-listed, USD-denominated ETF or closed-end fund. Show 1-day,
1-week, 1-month, and year-to-date price return in one view.

## Decisions

1. **Price return only.** The interface never implies total return.
2. **Previous close everywhere.** Every view labels its time basis.
3. **Pipeline health and data completeness are separate.** A correctly recorded
   suspension is a healthy pipeline outcome, not a missing-data defect.
4. **Expected records have a denominator.** Provider failures cannot disappear
   because both ingestion runs and fetch outcomes are persisted.
5. **Revisions are events, not statuses.** Current state stays queryable while
   every atomic change receives one permanent receipt.
6. **Creation is receipted.** A new record emits `0 → 1`, so
   `daily_record.version = COUNT(record_event)` without a special case.
7. **Exact decimals cross every boundary.** Prices use canonical six-place
   strings in application code, JSON changes, and SQLite.
8. **Fund identity is not its ticker.** `fund_id` is permanent; ticker
   assignments carry validity dates and cannot overlap.
9. **Reruns are idempotent.** An empty candidate change set writes nothing and
   does not increase the version.
10. **Recent history is reconciled.** Each run revisits seven sessions to catch
    backfills and provider corrections while keeping work bounded.
11. **Stored gaps remain gaps.** Read-time comparison logic may choose the last
    priced boundary, but write-time forward filling is forbidden.
12. **Runs are single-flight.** A database lease rejects overlaps and rapid
    manual repeats, then recovers an abandoned run after fifteen minutes.
13. **Read paths stay read-only.** A generated deployment migration owns the
    tables and checks. Before an ingestion path can write, an idempotent D1
    bootstrap installs the custom integrity triggers the host migration parser
    cannot accept; opening the dashboard performs no DDL or bootstrap writes.
14. **Historical denominators are immutable.** Reference sessions and every
    run's expected fund/session pairs are persisted; today's watchlist cannot
    rewrite yesterday's score.
15. **Ticker history is append-only.** Reconciliation resolves the assignment
    valid on each session. Existing identity/effective-date fields cannot be
    edited or deleted after the fact.

## Explicit v1 exclusions

Unit trusts, hedge funds, non-USD listings, brokerage connections, order
execution, cost-basis accounting, total-return calculation, AI-generated
recommendations, multi-provider conflict resolution, and public multi-user
accounts.

## Operational caveat

The source declares a Singapore-morning capture at 23:15 UTC Monday–Friday and
a reconciliation run at 09:45 UTC Tuesday–Saturday. Production readiness still
requires evidence from the deployed host that both triggers are registered,
plus a real provider key. The hosted v1 remains private. The 20-session success
gate cannot be claimed from fixtures or tests.
