#!/usr/bin/env python3
"""Generate one optional prose-only market note through OpenRouter.

This script is deliberately fail-open. Market data and deployment remain useful
when the API key is missing, OpenRouter is unavailable, or validation rejects a
response.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FUNDS_PATH = PROJECT_ROOT / "public" / "data" / "funds.json"
HISTORY_PATH = PROJECT_ROOT / "public" / "data" / "pipeline-history.json"
OUTPUT_PATH = PROJECT_ROOT / "public" / "data" / "session-summary.json"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
ROUTER_MODEL = "openrouter/free"
SITE_URL = "https://elizabeth5138.github.io/closewatch-fund-tracker/"

NUMBER_PATTERN = re.compile(r"(?<![A-Za-z])[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)%?")
TRAILING_NUMERIC_PUNCTUATION = ",.;:!?)]}\"'"
MIN_SUMMARY_CHARACTERS = 40
MAX_SUMMARY_CHARACTERS = 700
ADVICE_PATTERN = re.compile(
    r"\b(?:buy|sell|hold|recommend|should|undervalued|overvalued|investment opportunity)\b",
    re.IGNORECASE,
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def canonical_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def build_facts(snapshot: dict[str, Any], history: dict[str, Any]) -> dict[str, Any]:
    session_date = snapshot["marketSession"]
    matching_run = next(
        (run for run in history.get("runs", []) if run.get("sessionDate") == session_date),
        None,
    )
    if matching_run is None:
        raise ValueError(f"No pipeline history for current session {session_date}")

    return {
        "session_date": session_date,
        "funds": [
            {
                "ticker": fund["ticker"],
                "kind": fund["kind"],
                "status": fund["status"],
                "previous_close": fund["price"],
                "returns": fund["returns"],
            }
            for fund in snapshot.get("funds", [])
        ],
        "pipeline": {
            "state": snapshot["pipeline"]["state"],
            "expected": matching_run["expected"],
            "resolved": matching_run["resolved"],
            "priced": matching_run["priced"],
            "failed": matching_run["failed"],
            "health_percent": snapshot["pipeline"]["resolvedPercent"],
            "completeness_percent": snapshot["pipeline"]["pricedPercent"],
        },
    }


def extract_numeric_tokens(text: str) -> list[str]:
    return sorted({
        token.rstrip(TRAILING_NUMERIC_PUNCTUATION)
        for token in NUMBER_PATTERN.findall(text)
        if token.rstrip(TRAILING_NUMERIC_PUNCTUATION)
    })


def validate_prose(text: str, source_payload: dict[str, Any] | None = None) -> dict[str, Any]:
    numeric_tokens = extract_numeric_tokens(text)
    source_tokens = set(extract_numeric_tokens(canonical_json(source_payload or {})))
    unmatched = sorted(token for token in numeric_tokens if token not in source_tokens)
    character_count = len(text.strip())
    length_passed = MIN_SUMMARY_CHARACTERS <= character_count <= MAX_SUMMARY_CHARACTERS
    reasons: list[str] = []
    if unmatched:
        reasons.append("unmatched_numbers")
    if "\n" in text or any(marker in text for marker in ("```", "{", "}")):
        reasons.append("not_plain_prose")
    if ADVICE_PATTERN.search(text):
        reasons.append("advice_language")
    if not length_passed:
        reasons.append("invalid_length")
    return {
        "passed": not reasons,
        "numeric_tokens": numeric_tokens,
        "unmatched": unmatched,
        "numeric_gate": {"passed": not unmatched},
        "length_gate": {
            "passed": length_passed,
            "characters": character_count,
            "minimum": MIN_SUMMARY_CHARACTERS,
            "maximum": MAX_SUMMARY_CHARACTERS,
        },
        "reasons": reasons,
    }


def parse_return(value: str | None) -> Decimal | None:
    if not value or value == "—":
        return None
    try:
        return Decimal(value.rstrip("%"))
    except InvalidOperation:
        return None


def template_summary(facts: dict[str, Any]) -> str:
    pipeline = facts["pipeline"]
    funds = facts["funds"]
    if pipeline["failed"] == 0:
        opening = (
            "The latest watchlist session resolved cleanly, with published closes "
            "available across the monitored funds."
        )
    else:
        opening = (
            "The latest watchlist session contains an unexplained data gap, while "
            "the available fund records remain visible."
        )

    moves = [parse_return(fund["returns"].get("oneDay")) for fund in funds]
    usable = [move for move in moves if move is not None]
    if usable and all(move > 0 for move in usable):
        movement = "Daily price moves were broadly positive across the watchlist."
    elif usable and all(move < 0 for move in usable):
        movement = "Daily price moves were broadly negative across the watchlist."
    elif usable and all(move == 0 for move in usable):
        movement = "Daily price action was quiet across the watchlist."
    else:
        movement = "Daily price moves were mixed across the watchlist."

    summary = f"{opening} {movement}"
    validation = validate_prose(summary, facts)
    if not validation["passed"]:
        raise AssertionError(f"Deterministic template violated prose contract: {validation}")
    return summary


def extract_content(response: dict[str, Any]) -> str:
    content = response["choices"][0]["message"]["content"]
    if isinstance(content, str):
        return " ".join(content.strip().strip('"').split())
    if isinstance(content, list):
        parts = [item.get("text", "") for item in content if isinstance(item, dict)]
        return " ".join(" ".join(parts).strip().strip('"').split())
    # Some routed reasoning models can complete successfully with a null content
    # field. Treat that as rejected output so the deterministic template is used
    # without spending the daily allowance on a retry.
    if content is None:
        return ""
    raise ValueError("OpenRouter response used an unsupported content shape")


def call_openrouter(api_key: str, facts: dict[str, Any]) -> tuple[str, str]:
    request_body = {
        "model": ROUTER_MODEL,
        "temperature": 0.2,
        "max_tokens": 512,
        "reasoning": {"effort": "minimal", "exclude": True},
        "messages": [
            {
                "role": "system",
                "content": (
                    "Write a short factual market-monitoring note. Use plain prose only. "
                    "Only quote numeric figures exactly as they appear in the supplied facts; "
                    "never calculate, reformat, round, or invent a figure. Number words are "
                    "allowed. Do not use bullet points, markdown, recommendations, or investment "
                    "advice. Describe direction and pipeline condition in two or three sentences."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Summarize these pipeline facts. Any numeric token you quote must be copied "
                    f"verbatim from this payload:\n{canonical_json(facts)}"
                ),
            },
        ],
    }
    request = Request(
        OPENROUTER_URL,
        data=json.dumps(request_body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": SITE_URL,
            "X-Title": "Closewatch Fund Tracker",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError("OpenRouter request failed") from exc

    if payload.get("error"):
        raise RuntimeError("OpenRouter returned an error")
    return extract_content(payload), str(payload.get("model") or ROUTER_MODEL)


def unavailable_record(
    facts: dict[str, Any], now: datetime, input_digest: str, attempted: bool
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "session_date": facts["session_date"],
        "summary": None,
        "generated_at": None,
        "attempt_date_utc": now.date().isoformat() if attempted else None,
        "attempted_at": now.isoformat().replace("+00:00", "Z") if attempted else None,
        "input_digest": input_digest,
        "input": facts,
        "validation": {
            "passed": False,
            "numeric_tokens": [],
            "unmatched": [],
            "numeric_gate": {"passed": None},
            "length_gate": {
                "passed": None,
                "characters": None,
                "minimum": MIN_SUMMARY_CHARACTERS,
                "maximum": MAX_SUMMARY_CHARACTERS,
            },
            "reasons": ["unavailable"],
        },
    }
    return payload


SummaryCaller = Callable[[str, dict[str, Any]], tuple[str, str]]


def generate_summary(
    funds_path: Path = FUNDS_PATH,
    history_path: Path = HISTORY_PATH,
    output_path: Path = OUTPUT_PATH,
    api_key: str | None = None,
    now: datetime | None = None,
    caller: SummaryCaller = call_openrouter,
) -> str:
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    if current_time.weekday() >= 5:
        print("AI note skipped: outside the weekday UTC schedule.")
        return "skipped_weekend"

    snapshot = read_json(funds_path)
    history = read_json(history_path)
    facts = build_facts(snapshot, history)
    input_digest = "sha256:" + hashlib.sha256(canonical_json(facts).encode("utf-8")).hexdigest()

    existing = read_json(output_path) if output_path.exists() else {}
    same_session = existing.get("session_date") == facts["session_date"]
    if same_session and existing.get("summary"):
        print("AI note skipped: this market session already has a summary.")
        return "skipped_existing"
    if existing.get("attempt_date_utc") == current_time.date().isoformat():
        print("AI note skipped: the daily call allowance was already used.")
        return "skipped_daily_limit"

    key = api_key if api_key is not None else os.getenv("OPENROUTER_API_KEY")
    if not key:
        print("AI note unavailable: OPENROUTER_API_KEY is not configured.")
        return "skipped_missing_key"

    try:
        summary, actual_model = caller(key, facts)
    except Exception as exc:
        atomic_json_write(
            output_path,
            unavailable_record(facts, current_time, input_digest, attempted=True),
        )
        print(f"AI note unavailable: {type(exc).__name__}; deployment continues.")
        return "request_failed"

    validation = validate_prose(summary, facts)
    source = "model"
    accepted_summary = summary
    if not validation["passed"]:
        source = "template"
        accepted_summary = template_summary(facts)

    output = {
        "schemaVersion": 1,
        "session_date": facts["session_date"],
        "summary": accepted_summary,
        "source": source,
        "model": actual_model,
        "model_router": ROUTER_MODEL,
        "generated_at": current_time.isoformat().replace("+00:00", "Z"),
        "attempt_date_utc": current_time.date().isoformat(),
        "attempted_at": current_time.isoformat().replace("+00:00", "Z"),
        "input_digest": input_digest,
        "input": facts,
        "validation": validation,
    }
    atomic_json_write(output_path, output)
    print(
        f"AI note written from {source}; "
        f"source-number gate passed: {str(validation['numeric_gate']['passed']).lower()}."
    )
    return source


def main() -> int:
    try:
        generate_summary()
    except Exception as exc:
        print(f"AI note unavailable: {type(exc).__name__}; deployment continues.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
