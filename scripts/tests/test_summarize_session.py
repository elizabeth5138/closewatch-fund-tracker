import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from scripts.summarize_session import (
    extract_content,
    generate_summary,
    template_summary,
    validate_prose,
)


NOW = datetime(2026, 8, 6, 2, 4, 11, tzinfo=timezone.utc)


def fixture_data(root: Path) -> tuple[Path, Path, Path]:
    funds = root / "funds.json"
    history = root / "history.json"
    output = root / "summary.json"
    funds.write_text(json.dumps({
        "marketSession": "2026-08-05",
        "pipeline": {
            "state": "healthy", "resolvedPercent": 100, "pricedPercent": 100
        },
        "funds": [
            {
                "ticker": "SPY", "kind": "ETF", "status": "priced",
                "price": "769.789978",
                "returns": {"oneDay": "+0.31%", "oneWeek": "+1.20%", "oneMonth": "+2.10%", "ytd": "+8.00%"},
            },
            {
                "ticker": "BND", "kind": "ETF", "status": "priced",
                "price": "72.459999",
                "returns": {"oneDay": "-0.10%", "oneWeek": "+0.20%", "oneMonth": "0.00%", "ytd": "+1.00%"},
            },
        ],
    }), encoding="utf-8")
    history.write_text(json.dumps({"runs": [{
        "sessionDate": "2026-08-05", "expected": 2, "resolved": 2,
        "priced": 2, "failed": 0, "status": "succeeded",
    }]}), encoding="utf-8")
    return funds, history, output


class SummaryTests(unittest.TestCase):
    def test_validator_accepts_plain_prose(self):
        result = validate_prose(
            "The latest session resolved cleanly across the watchlist. "
            "Daily price moves were mixed and no unexplained gaps were present."
        )
        self.assertTrue(result["passed"])

    def test_validator_rejects_digits_number_words_and_advice(self):
        self.assertFalse(validate_prose("The fund rose 2 percent during the session.")["passed"])
        self.assertFalse(validate_prose("All four funds produced a close during the session.")["passed"])
        self.assertFalse(validate_prose("Investors should buy after the latest move.")["passed"])

    def test_template_contains_no_numeric_content(self):
        facts = {
            "pipeline": {"failed": 0},
            "funds": [{"returns": {"oneDay": "+0.20%"}}, {"returns": {"oneDay": "-0.10%"}}],
        }
        self.assertTrue(validate_prose(template_summary(facts))["passed"])

    def test_null_model_content_becomes_rejected_empty_output(self):
        response = {"choices": [{"message": {"content": None}}]}
        self.assertEqual(extract_content(response), "")

    def test_empty_model_output_uses_template_without_retry(self):
        calls = []

        def caller(_key, _facts):
            calls.append(True)
            return "", "provider/free-model"

        with tempfile.TemporaryDirectory() as directory:
            funds, history, output = fixture_data(Path(directory))
            result = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result, "template")
            self.assertEqual(saved["source"], "template")
            self.assertEqual(saved["validation"]["reasons"], ["invalid_length"])
            self.assertTrue(validate_prose(saved["summary"])["passed"])
            self.assertEqual(len(calls), 1)

    def test_missing_key_exits_without_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            funds, history, output = fixture_data(Path(directory))
            result = generate_summary(funds, history, output, api_key="", now=NOW)
            self.assertEqual(result, "skipped_missing_key")
            self.assertFalse(output.exists())

    def test_model_is_called_once_and_same_session_is_idempotent(self):
        calls = []

        def caller(key, facts):
            calls.append((key, facts))
            return (
                "The latest session resolved cleanly across the watchlist. "
                "Daily price moves were mixed and the pipeline reported no unexplained gaps.",
                "provider/free-model",
            )

        with tempfile.TemporaryDirectory() as directory:
            funds, history, output = fixture_data(Path(directory))
            first = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            second = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(first, "model")
            self.assertEqual(second, "skipped_existing")
            self.assertEqual(len(calls), 1)
            self.assertEqual(saved["source"], "model")
            self.assertTrue(saved["validation"]["passed"])

    def test_daily_limit_applies_even_if_session_changes(self):
        calls = []

        def caller(_key, _facts):
            calls.append(True)
            return (
                "The latest session resolved cleanly across the watchlist. "
                "Daily price moves were mixed and the pipeline reported no unexplained gaps.",
                "provider/free-model",
            )

        with tempfile.TemporaryDirectory() as directory:
            funds, history, output = fixture_data(Path(directory))
            first = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)

            snapshot = json.loads(funds.read_text(encoding="utf-8"))
            snapshot["marketSession"] = "2026-08-06"
            funds.write_text(json.dumps(snapshot), encoding="utf-8")
            run_history = json.loads(history.read_text(encoding="utf-8"))
            run_history["runs"].insert(0, {
                "sessionDate": "2026-08-06", "expected": 2, "resolved": 2,
                "priced": 2, "failed": 0, "status": "succeeded",
            })
            history.write_text(json.dumps(run_history), encoding="utf-8")

            second = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            self.assertEqual(first, "model")
            self.assertEqual(second, "skipped_daily_limit")
            self.assertEqual(len(calls), 1)

    def test_numeric_model_output_is_replaced_by_template(self):
        def caller(_key, _facts):
            return "All 2 funds were priced and the pipeline was 100% complete.", "provider/free-model"

        with tempfile.TemporaryDirectory() as directory:
            funds, history, output = fixture_data(Path(directory))
            result = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result, "template")
            self.assertEqual(saved["source"], "template")
            self.assertFalse(saved["validation"]["passed"])
            self.assertTrue(validate_prose(saved["summary"])["passed"])

    def test_request_failure_is_recorded_and_not_retried_same_day(self):
        calls = []

        def caller(_key, _facts):
            calls.append(True)
            raise TimeoutError("timeout")

        with tempfile.TemporaryDirectory() as directory:
            funds, history, output = fixture_data(Path(directory))
            first = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            second = generate_summary(funds, history, output, api_key="secret", now=NOW, caller=caller)
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(first, "request_failed")
            self.assertEqual(second, "skipped_daily_limit")
            self.assertEqual(len(calls), 1)
            self.assertIsNone(saved["summary"])


if __name__ == "__main__":
    unittest.main()
