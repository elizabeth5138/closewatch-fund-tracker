#!/usr/bin/env python3
"""Refresh Closewatch's static market snapshot with yfinance.

The output is deliberately boring JSON: GitHub Pages can serve it directly,
and the frontend can render it without a database or API key.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any

import yfinance as yf


PRICE_SCALE = Decimal("0.000001")
HISTORY_LIMIT = 60
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WATCHLIST = PROJECT_ROOT / "watchlist.json"
DEFAULT_SNAPSHOT = PROJECT_ROOT / "public" / "data" / "funds.json"
DEFAULT_HISTORY = PROJECT_ROOT / "public" / "data" / "pipeline-history.json"
DEFAULT_EVENTS = PROJECT_ROOT / "public" / "data" / "record-events.json"


@dataclass(frozen=True)
class FundConfig:
    ticker: str
    name: str
    kind: str


def canonical_price(value: Any) -> str:
    """Convert provider values to one stable six-decimal representation."""
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Invalid price: {value!r}") from exc
    if not number.is_finite() or number < 0:
        raise ValueError(f"Invalid price: {value!r}")
    return format(number.quantize(PRICE_SCALE, rounding=ROUND_HALF_UP), "f")


def percent_change(current: str, baseline: str | None) -> str | None:
    if baseline is None:
        return None
    old = Decimal(baseline)
    if old == 0:
        return None
    change = ((Decimal(current) - old) / old * Decimal(100)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    prefix = "+" if change > 0 else ""
    return f"{prefix}{change:.2f}%"


def one_month_before(day: date) -> date:
    month = day.month - 1 or 12
    year = day.year if day.month > 1 else day.year - 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def latest_on_or_before(points: list[tuple[date, str, int]], target: date) -> str | None:
    matches = [price for session, price, _volume in points if session <= target]
    return matches[-1] if matches else None


def load_watchlist(path: Path) -> tuple[str, list[FundConfig]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    reference = str(payload.get("referenceTicker", "SPY")).strip().upper()
    raw_funds = payload.get("funds", [])
    if not isinstance(raw_funds, list) or not raw_funds:
        raise ValueError("watchlist.json must contain a non-empty 'funds' list")

    funds: list[FundConfig] = []
    seen: set[str] = set()
    for item in raw_funds:
        if isinstance(item, str):
            ticker = item.strip().upper()
            name = ticker
            kind = "ETF"
        elif isinstance(item, dict):
            ticker = str(item.get("ticker", "")).strip().upper()
            name = str(item.get("name") or ticker).strip()
            kind = str(item.get("kind") or "ETF").strip().upper()
        else:
            raise ValueError("Each watchlist fund must be a ticker string or an object")
        if not ticker or not ticker.replace("-", "").replace(".", "").isalnum():
            raise ValueError(f"Invalid ticker in watchlist: {ticker!r}")
        if kind not in {"ETF", "CEF"}:
            raise ValueError(f"{ticker}: kind must be ETF or CEF")
        if ticker in seen:
            raise ValueError(f"Duplicate ticker in watchlist: {ticker}")
        seen.add(ticker)
        funds.append(FundConfig(ticker=ticker, name=name, kind=kind))

    if reference not in seen:
        raise ValueError(f"Reference ticker {reference} must also be in the funds list")
    return reference, funds


def download_points(ticker: str) -> list[tuple[date, str, int]]:
    frame = yf.Ticker(ticker).history(
        period="2y",
        interval="1d",
        auto_adjust=False,
        actions=False,
        timeout=30,
    )
    if frame.empty or "Close" not in frame or "Volume" not in frame:
        raise RuntimeError("provider returned no daily close/volume history")

    points: list[tuple[date, str, int]] = []
    for timestamp, row in frame.iterrows():
        close = row.get("Close")
        volume = row.get("Volume")
        if close is None or str(close).lower() == "nan":
            continue
        session = timestamp.date()
        points.append((session, canonical_price(close), int(volume or 0)))
    if not points:
        raise RuntimeError("provider returned no usable daily closes")
    points.sort(key=lambda point: point[0])
    return points


def build_fund(
    config: FundConfig,
    points: list[tuple[date, str, int]],
    expected_session: date,
) -> dict[str, Any]:
    exact = [point for point in points if point[0] == expected_session]
    if not exact:
        raise RuntimeError(f"no close for reference session {expected_session.isoformat()}")

    _session, current, volume = exact[-1]
    earlier = [point for point in points if point[0] < expected_session]
    previous = earlier[-1][1] if earlier else None
    status = "no_trade" if volume == 0 and previous == current else "priced"
    start_of_year = date(expected_session.year, 1, 1) - timedelta(days=1)

    return {
        "id": config.ticker.lower().replace(".", "-") ,
        "ticker": config.ticker,
        "name": config.name,
        "kind": config.kind,
        "currency": "USD",
        "sessionDate": expected_session.isoformat(),
        "status": status,
        "price": current,
        "volume": volume,
        "returns": {
            "oneDay": percent_change(current, previous),
            "oneWeek": percent_change(
                current, latest_on_or_before(points, expected_session - timedelta(days=7))
            ),
            "oneMonth": percent_change(
                current, latest_on_or_before(points, one_month_before(expected_session))
            ),
            "ytd": percent_change(current, latest_on_or_before(points, start_of_year)),
        },
        "sparkline": [price for _day, price, _volume in points if _day <= expected_session][-12:],
        "error": None,
    }


def missing_fund(config: FundConfig, expected_session: date, error: Exception) -> dict[str, Any]:
    return {
        "id": config.ticker.lower().replace(".", "-"),
        "ticker": config.ticker,
        "name": config.name,
        "kind": config.kind,
        "currency": "USD",
        "sessionDate": expected_session.isoformat(),
        "status": "missing",
        "price": None,
        "volume": None,
        "returns": {"oneDay": None, "oneWeek": None, "oneMonth": None, "ytd": None},
        "sparkline": [],
        "error": str(error),
    }


def read_history(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schemaVersion": 1, "runs": []}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload.get("runs"), list):
        raise ValueError("pipeline history has an invalid 'runs' value")
    return payload


def qualifying_streak(runs: list[dict[str, Any]]) -> int:
    streak = 0
    for run in sorted(runs, key=lambda item: item["sessionDate"], reverse=True):
        expected = int(run.get("expected", 0))
        priced = int(run.get("priced", 0))
        if (
            run.get("status") != "succeeded"
            or expected == 0
            or int(run.get("resolved", 0)) != expected
            or priced / expected < 0.99
        ):
            break
        streak += 1
    return min(streak, 20)


def validate_event_chains(events: list[dict[str, Any]]) -> None:
    versions: dict[str, int] = {}
    for event in events:
        key = str(event["recordKey"])
        expected = versions.get(key, 0)
        if int(event["fromVersion"]) != expected:
            raise ValueError(
                f"Broken event chain for {key}: expected fromVersion {expected}, "
                f"got {event['fromVersion']}"
            )
        to_version = int(event["toVersion"])
        if to_version != expected + 1:
            raise ValueError(f"Broken event chain for {key}: versions must advance by one")
        versions[key] = to_version


def apply_version_events(
    funds: list[dict[str, Any]],
    previous_snapshot_path: Path,
    events_path: Path,
    detected_at: str,
) -> dict[str, Any]:
    previous_funds: dict[str, dict[str, Any]] = {}
    if previous_snapshot_path.exists():
        previous_payload = json.loads(previous_snapshot_path.read_text(encoding="utf-8"))
        previous_funds = {
            f"{fund['ticker']}|{fund['sessionDate']}": fund
            for fund in previous_payload.get("funds", [])
        }

    event_payload = (
        json.loads(events_path.read_text(encoding="utf-8"))
        if events_path.exists()
        else {"schemaVersion": 1, "events": []}
    )
    events = event_payload.get("events")
    if not isinstance(events, list):
        raise ValueError("record event log has an invalid 'events' value")
    validate_event_chains(events)

    for fund in funds:
        key = f"{fund['ticker']}|{fund['sessionDate']}"
        previous = previous_funds.get(key)
        from_version = int(previous.get("version", 0)) if previous else 0
        fields = ("status", "price", "volume")
        changes = {
            field: {
                "old": previous.get(field) if previous else None,
                "new": fund.get(field),
            }
            for field in fields
            if previous is None or previous.get(field) != fund.get(field)
        }
        if not changes:
            fund["version"] = from_version
            continue

        to_version = from_version + 1
        events.append(
            {
                "recordKey": key,
                "ticker": fund["ticker"],
                "sessionDate": fund["sessionDate"],
                "kind": "created" if from_version == 0 else "revised",
                "fromVersion": from_version,
                "toVersion": to_version,
                "detectedAt": detected_at,
                "source": "Yahoo Finance via yfinance",
                "changes": changes,
            }
        )
        fund["version"] = to_version

    validate_event_chains(events)
    event_payload["events"] = events
    return event_payload


def atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def refresh(
    watchlist_path: Path,
    snapshot_path: Path,
    history_path: Path,
    events_path: Path,
) -> dict[str, Any]:
    reference_ticker, configs = load_watchlist(watchlist_path)
    fetched: dict[str, list[tuple[date, str, int]]] = {}
    errors: dict[str, Exception] = {}

    for config in configs:
        try:
            fetched[config.ticker] = download_points(config.ticker)
        except Exception as exc:  # each ticker must stay visible in the denominator
            errors[config.ticker] = exc

    if reference_ticker in errors or reference_ticker not in fetched:
        raise RuntimeError(
            f"Reference ticker {reference_ticker} failed: {errors.get(reference_ticker, 'no data')}"
        )

    expected_session = fetched[reference_ticker][-1][0]
    funds: list[dict[str, Any]] = []
    for config in configs:
        try:
            if config.ticker in errors:
                raise errors[config.ticker]
            funds.append(build_fund(config, fetched[config.ticker], expected_session))
        except Exception as exc:
            funds.append(missing_fund(config, expected_session, exc))

    expected = len(funds)
    priced = sum(fund["status"] == "priced" for fund in funds)
    resolved = sum(fund["status"] not in {"missing", "pending"} for fund in funds)
    failed = expected - resolved
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    run_status = "succeeded" if failed == 0 else "partial"
    event_payload = apply_version_events(funds, snapshot_path, events_path, generated_at)

    history = read_history(history_path)
    run = {
        "sessionDate": expected_session.isoformat(),
        "generatedAt": generated_at,
        "expected": expected,
        "resolved": resolved,
        "priced": priced,
        "failed": failed,
        "status": run_status,
    }
    prior_runs = [item for item in history["runs"] if item.get("sessionDate") != run["sessionDate"]]
    history["runs"] = sorted(prior_runs + [run], key=lambda item: item["sessionDate"])[-HISTORY_LIMIT:]
    streak = qualifying_streak(history["runs"])

    snapshot = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "marketSession": expected_session.isoformat(),
        "source": "Yahoo Finance via yfinance",
        "currency": "USD",
        "returnType": "price",
        "pipeline": {
            "state": "healthy" if failed == 0 else "attention",
            "label": "Pipeline healthy" if failed == 0 else "Pipeline needs attention",
            "detail": f"{resolved}/{expected} expected records resolved",
            "expected": expected,
            "resolved": resolved,
            "priced": priced,
            "failed": failed,
            "resolvedPercent": round(resolved / expected * 100) if expected else 0,
            "pricedPercent": round(priced / expected * 100) if expected else 0,
            "successRun": streak,
        },
        "funds": funds,
    }

    atomic_json_write(history_path, history)
    atomic_json_write(events_path, event_payload)
    atomic_json_write(snapshot_path, snapshot)
    return snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh Closewatch market data")
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--output", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--history", type=Path, default=DEFAULT_HISTORY)
    parser.add_argument("--events", type=Path, default=DEFAULT_EVENTS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        snapshot = refresh(args.watchlist, args.output, args.history, args.events)
    except Exception as exc:
        print(f"Refresh failed: {exc}", file=sys.stderr)
        return 1
    pipeline = snapshot["pipeline"]
    print(
        f"Refreshed {pipeline['resolved']}/{pipeline['expected']} funds "
        f"for {snapshot['marketSession']} ({pipeline['state']})."
    )
    # A partial run is still a successfully recorded observation: its missing
    # rows must be committed so the dashboard denominator stays honest.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
