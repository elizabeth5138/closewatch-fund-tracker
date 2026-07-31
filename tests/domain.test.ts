import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizePrice,
  canonicalizeVolume,
  computeChangeSet,
  createTransition,
  formatPriceReturn,
  statusAfterArrivalWindow,
  validateEventChain,
  type CandidateObservation,
  type DailyRecord,
} from "../lib/domain.ts";

const candidate: CandidateObservation = {
  fundId: "fund_spy",
  sessionDate: "2026-07-29",
  status: "priced",
  price: "100.12",
  volume: "45210",
  source: "test_provider",
};

test("canonicalizes equivalent prices to one exact six-place representation", () => {
  assert.equal(canonicalizePrice("100.12"), "100.120000");
  assert.equal(canonicalizePrice("0100.120000"), "100.120000");
  assert.equal(canonicalizePrice("100.1200004"), "100.120000");
  assert.equal(canonicalizePrice("100.1200005"), "100.120001");
  assert.equal(canonicalizePrice("99.9999995"), "100.000000");
});

test("rejects unsafe or nonsensical price and volume input", () => {
  for (const value of ["-1.00", "1e2", "NaN", "", "1,000.00"]) {
    assert.throws(() => canonicalizePrice(value));
  }
  assert.equal(canonicalizeVolume("00042"), "42");
  assert.throws(() => canonicalizeVolume("42.5"));
  assert.throws(() => canonicalizeVolume(-1));
});

test("creation is a receipted 0 to 1 atomic transition", () => {
  const transition = createTransition(
    null,
    candidate,
    "2026-07-30T10:00:00.000Z",
    "event-1",
  );
  assert.ok(transition);
  assert.equal(transition.record.version, 1);
  assert.equal(transition.event.eventType, "created");
  assert.equal(transition.event.fromVersion, 0);
  assert.equal(transition.event.toVersion, 1);
  assert.deepEqual(Object.keys(transition.event.changes).sort(), [
    "price",
    "source",
    "status",
    "volume",
  ]);
});

test("equivalent decimal spellings are idempotent", () => {
  const current: DailyRecord = {
    ...candidate,
    price: "100.120000",
    version: 1,
    updatedAt: "2026-07-30T10:00:00.000Z",
  };
  assert.deepEqual(
    computeChangeSet(current, { ...candidate, price: "100.1200000" }),
    {},
  );
  assert.equal(
    createTransition(
      current,
      { ...candidate, price: "100.1200000" },
      "2026-07-30T11:00:00.000Z",
    ),
    null,
  );
});

test("one provider observation bundles every changed field into one event", () => {
  const created = createTransition(
    null,
    candidate,
    "2026-07-30T10:00:00.000Z",
    "event-1",
  );
  assert.ok(created);
  const revised = createTransition(
    created.record,
    {
      ...candidate,
      status: "no_trade",
      price: "100.13",
      volume: "0",
    },
    "2026-07-30T12:00:00.000Z",
    "event-2",
  );
  assert.ok(revised);
  assert.equal(revised.record.version, 2);
  assert.equal(revised.event.fromVersion, 1);
  assert.equal(revised.event.toVersion, 2);
  assert.deepEqual(Object.keys(revised.event.changes).sort(), [
    "price",
    "status",
    "volume",
  ]);
  assert.deepEqual(validateEventChain([created.event, revised.event]), {
    valid: true,
  });
});

test("event-chain validation catches a broken version link", () => {
  const created = createTransition(
    null,
    candidate,
    "2026-07-30T10:00:00.000Z",
    "event-1",
  );
  assert.ok(created);
  const broken = {
    ...created.event,
    id: "event-3",
    eventType: "revised" as const,
    fromVersion: 2,
    toVersion: 3,
  };
  const result = validateEventChain([created.event, broken]);
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Broken chain/);
});

test("price-return formatting is exact at the displayed precision", () => {
  assert.equal(formatPriceReturn("110.000000", "100.000000"), "+10.00%");
  assert.equal(formatPriceReturn("90.000000", "100.000000"), "−10.00%");
  assert.equal(formatPriceReturn("100.000000", "100.000000"), "0.00%");
  assert.equal(formatPriceReturn("100.000000", null), "—");
});

test("absence is pending inside the arrival window and missing after it", () => {
  assert.equal(
    statusAfterArrivalWindow(
      false,
      new Date("2026-07-30T09:59:59Z"),
      "2026-07-29",
    ),
    "pending",
  );
  assert.equal(
    statusAfterArrivalWindow(
      false,
      new Date("2026-07-30T10:00:00Z"),
      "2026-07-29",
    ),
    "missing",
  );
  assert.equal(
    statusAfterArrivalWindow(
      true,
      new Date("2026-07-30T10:00:00Z"),
      "2026-07-29",
    ),
    null,
  );
});
