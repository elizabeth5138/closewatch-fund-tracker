export const PRICE_SCALE = 6;
export const ARRIVAL_HOUR_UTC = 10;

export type RecordStatus =
  | "pending"
  | "priced"
  | "no_trade"
  | "suspended"
  | "not_listed"
  | "missing";

export type DailyRecord = {
  fundId: string;
  sessionDate: string;
  status: RecordStatus;
  price: string | null;
  volume: string | null;
  source: string;
  version: number;
  updatedAt: string;
};

export type CandidateObservation = Omit<DailyRecord, "version" | "updatedAt">;

export type FieldChange = { old: string | number | null; new: string | number | null };
export type ChangeSet = Record<string, FieldChange>;

export type RecordEvent = {
  id: string;
  fundId: string;
  sessionDate: string;
  fromVersion: number;
  toVersion: number;
  eventType: "created" | "revised";
  changes: ChangeSet;
  source: string;
  detectedAt: string;
};

const COMPARABLE_FIELDS = ["status", "price", "volume", "source"] as const;

export function canonicalizePrice(input: string): string {
  const value = input.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`Invalid non-negative decimal price: ${input}`);

  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fractional = match[2] ?? "";
  const kept = fractional.slice(0, PRICE_SCALE).padEnd(PRICE_SCALE, "0");
  const nextDigit = fractional[PRICE_SCALE] ?? "0";

  let scaled = BigInt(whole) * 10n ** BigInt(PRICE_SCALE) + BigInt(kept);
  if (nextDigit >= "5") scaled += 1n;

  const divisor = 10n ** BigInt(PRICE_SCALE);
  const normalizedWhole = scaled / divisor;
  const normalizedFraction = String(scaled % divisor).padStart(PRICE_SCALE, "0");
  return `${normalizedWhole}.${normalizedFraction}`;
}

export function canonicalizeVolume(input: string | number): string {
  const value = String(input).trim();
  if (!/^\d+$/.test(value)) throw new Error(`Invalid non-negative volume: ${input}`);
  return BigInt(value).toString();
}

export function normalizeCandidate(
  candidate: CandidateObservation,
): CandidateObservation {
  const price =
    candidate.price === null ? null : canonicalizePrice(candidate.price);
  const volume =
    candidate.volume === null ? null : canonicalizeVolume(candidate.volume);

  if (candidate.status === "priced" && price === null) {
    throw new Error("A priced record must have a price.");
  }
  if (candidate.status === "no_trade" && volume !== "0") {
    throw new Error("A no_trade record must have zero volume.");
  }

  return { ...candidate, price, volume };
}

export function computeChangeSet(
  current: DailyRecord | null,
  candidateInput: CandidateObservation,
): ChangeSet {
  const candidate = normalizeCandidate(candidateInput);
  const changes: ChangeSet = {};

  for (const field of COMPARABLE_FIELDS) {
    const oldValue = current ? current[field] : null;
    const newValue = candidate[field];
    if (!current || oldValue !== newValue) {
      changes[field] = { old: oldValue, new: newValue };
    }
  }
  return changes;
}

export function createTransition(
  current: DailyRecord | null,
  candidateInput: CandidateObservation,
  detectedAt: string,
  eventId = crypto.randomUUID(),
): { record: DailyRecord; event: RecordEvent } | null {
  const candidate = normalizeCandidate(candidateInput);
  const changes = computeChangeSet(current, candidate);
  if (Object.keys(changes).length === 0) return null;

  const fromVersion = current?.version ?? 0;
  const toVersion = fromVersion + 1;
  const record: DailyRecord = {
    ...candidate,
    version: toVersion,
    updatedAt: detectedAt,
  };
  const event: RecordEvent = {
    id: eventId,
    fundId: candidate.fundId,
    sessionDate: candidate.sessionDate,
    fromVersion,
    toVersion,
    eventType: current ? "revised" : "created",
    changes,
    source: candidate.source,
    detectedAt,
  };
  return { record, event };
}

export function validateEventChain(eventsInput: RecordEvent[]): {
  valid: boolean;
  error?: string;
} {
  const events = [...eventsInput].sort((a, b) => a.toVersion - b.toVersion);
  let expectedFrom = 0;
  for (const event of events) {
    if (event.fromVersion !== expectedFrom || event.toVersion !== expectedFrom + 1) {
      return {
        valid: false,
        error: `Broken chain at version ${event.toVersion}: expected ${expectedFrom} → ${expectedFrom + 1}.`,
      };
    }
    expectedFrom = event.toVersion;
  }
  return { valid: true };
}

function scaledPrice(value: string): bigint {
  return BigInt(canonicalizePrice(value).replace(".", ""));
}

export function formatPriceReturn(
  currentPrice: string,
  comparisonPrice: string | null,
): string {
  if (!comparisonPrice) return "—";
  const current = scaledPrice(currentPrice);
  const comparison = scaledPrice(comparisonPrice);
  if (comparison === 0n) return "—";

  const numerator = (current - comparison) * 10000n;
  const roundedMagnitude =
    ((numerator < 0n ? -numerator : numerator) + comparison / 2n) / comparison;
  const hundredthsOfPercent = numerator < 0n ? -roundedMagnitude : roundedMagnitude;
  const sign = hundredthsOfPercent > 0n ? "+" : hundredthsOfPercent < 0n ? "−" : "";
  const absolute = hundredthsOfPercent < 0n ? -hundredthsOfPercent : hundredthsOfPercent;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}%`;
}

export function statusAfterArrivalWindow(
  hasObservation: boolean,
  now: Date,
  sessionDate: string,
  arrivalHourUtc = ARRIVAL_HOUR_UTC,
): "pending" | "missing" | null {
  if (hasObservation) return null;
  const deadline = new Date(`${sessionDate}T00:00:00.000Z`);
  deadline.setUTCDate(deadline.getUTCDate() + 1);
  deadline.setUTCHours(arrivalHourUtc);
  return now < deadline ? "pending" : "missing";
}
