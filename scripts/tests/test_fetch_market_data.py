import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from scripts.fetch_market_data import (
    apply_version_events,
    canonical_price,
    one_month_before,
    percent_change,
    qualifying_streak,
    validate_event_chains,
)


class MarketDataTests(unittest.TestCase):
    def test_price_is_canonicalized_before_comparison(self):
        self.assertEqual(canonical_price("100.12"), "100.120000")
        self.assertEqual(canonical_price(100.120000), "100.120000")

    def test_price_return_uses_decimal_arithmetic(self):
        self.assertEqual(percent_change("101.000000", "100.000000"), "+1.00%")
        self.assertEqual(percent_change("99.000000", "100.000000"), "-1.00%")

    def test_month_boundary(self):
        self.assertEqual(one_month_before(date(2024, 3, 31)), date(2024, 2, 29))

    def test_success_streak_stops_at_first_failed_session(self):
        runs = [
            {"sessionDate": "2026-07-29", "expected": 4, "resolved": 3, "priced": 3, "status": "partial"},
            {"sessionDate": "2026-07-30", "expected": 4, "resolved": 4, "priced": 4, "status": "succeeded"},
            {"sessionDate": "2026-07-31", "expected": 4, "resolved": 4, "priced": 4, "status": "succeeded"},
        ]
        self.assertEqual(qualifying_streak(runs), 2)

    def test_created_event_and_identical_rerun_are_idempotent(self):
        fund = {
            "ticker": "SPY", "sessionDate": "2026-07-31", "status": "priced",
            "price": "100.120000", "volume": 10,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "funds.json"
            events = root / "events.json"
            first = apply_version_events([fund.copy()], snapshot, events, "2026-08-01T00:00:00Z")
            self.assertEqual(first["events"][0]["fromVersion"], 0)
            self.assertEqual(first["events"][0]["toVersion"], 1)

            stored_fund = fund | {"version": 1}
            snapshot.write_text(json.dumps({"funds": [stored_fund]}), encoding="utf-8")
            events.write_text(json.dumps(first), encoding="utf-8")
            second_fund = fund.copy()
            second = apply_version_events([second_fund], snapshot, events, "2026-08-01T01:00:00Z")
            self.assertEqual(len(second["events"]), 1)
            self.assertEqual(second_fund["version"], 1)

    def test_chain_rejects_a_gap(self):
        with self.assertRaises(ValueError):
            validate_event_chains([
                {"recordKey": "SPY|2026-07-31", "fromVersion": 1, "toVersion": 2}
            ])


if __name__ == "__main__":
    unittest.main()
