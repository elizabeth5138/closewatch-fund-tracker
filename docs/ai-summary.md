# Prose-only session note

Closewatch makes at most one language-model call per weekday UTC, inside the
existing GitHub Action. The static browser application never calls a model and
never receives an API key.

## Provider and call budget

The workflow uses OpenRouter's `openrouter/free` router. The router selects a
currently available free model. The actual routed model identifier is stored in
`public/data/session-summary.json` for audit, while the page uses the constant
label `OpenRouter free model` so provider metadata cannot introduce a number
into the prose surface.

`scripts/summarize_session.py` enforces the call budget before making a request:

- no call outside the weekday UTC schedule;
- no call when the current market session already has a summary;
- no second call on the same UTC date after an API attempt, including a failed
  request;
- no call when `OPENROUTER_API_KEY` is missing.

Manual workflow reruns therefore cannot silently multiply calls.

## Turn it on

Create an OpenRouter key at
[`openrouter.ai/settings/keys`](https://openrouter.ai/settings/keys). In the
GitHub repository, open **Settings → Secrets and variables → Actions → New
repository secret**, name it exactly `OPENROUTER_API_KEY`, and paste the key.
The value stays in GitHub Actions and must never be committed or exposed to the
browser.

## Numeric firewall

The model receives a compact, auditable copy of the current market and pipeline
facts, but its accepted output is qualitative prose only. Validation rejects:

- digits and numeric expressions;
- number words and ordinals;
- percent and currency symbols;
- markdown or structured output;
- recommendation and trading language.

Any rejected model response is discarded and replaced by a deterministic
template derived from the same pipeline facts. The template passes through the
same validator. No model-produced number is rendered or used in any dashboard
calculation.

## Fail-open behavior

Missing credentials, timeouts, provider errors, malformed responses, and all
other summary failures exit successfully so market-data collection and Pages
deployment continue. The page renders nothing when the summary is unavailable
or belongs to a different market session.

## Provenance

Each output records the exact fact payload, its SHA-256 digest, the router and
actual routed model, the attempt timestamp, the accepted source (`model` or
`template`), and validation details. Inputs contain public market observations
only. Do not add personal, confidential, or portfolio information to this
payload because free model providers may retain prompts under their own terms.
