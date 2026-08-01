# Closewatch

Closewatch is a static Singapore-morning monitor for the previous close of
US-listed ETFs and closed-end funds. It shows 1-day, 1-week, 1-month, and YTD
**price return** (not total return), plus whether the automated refresh covered
every expected watchlist record.

It is a research and monitoring tool. It does not trade or give advice.

## How the pieces fit

```text
watchlist.json
      ↓
scripts/fetch_market_data.py  →  Yahoo Finance through yfinance
      ↓
public/data/*.json            →  committed history + current snapshot
      ↓
existing Next.js dashboard    →  static GitHub Pages site
```

The GitHub Action runs at **23:30 UTC Monday–Friday**, which is **07:30 SGT
Tuesday–Saturday**. It refreshes the JSON, commits any changes, builds the
existing frontend, and deploys the static result to GitHub Pages. A market
holiday does not add a fake session because SPY anchors the expected US session.

## Manage the watchlist

Edit [`watchlist.json`](watchlist.json). Each fund can be a descriptive object:

```json
{ "ticker": "VT", "name": "Vanguard Total World Stock ETF", "kind": "ETF" }
```

Or, for the quickest addition, a ticker string also works:

```json
"VT"
```

Keep commas between entries and leave the reference ticker (`SPY`) in the list.
Commit the change to `main`; the next scheduled or manual workflow run will pick
it up. Removing a fund is the reverse: delete its line and commit.

## What the generated files mean

- `public/data/funds.json` is the current frontend snapshot.
- `public/data/pipeline-history.json` has one idempotent summary per market
  session and drives the 20-session card.
- `public/data/record-events.json` stores bundled `created`/`revised` receipts
  for price, volume, and status. Event versions form an unbroken chain.

Prices are strings normalized to six decimal places. Volume is stored alongside
price, allowing a zero-volume unchanged close to be labelled `no_trade` rather
than silently treated as a fresh trade.

Pipeline health is resolved records divided by expected watchlist records.
Data completeness is genuinely priced records divided by the same denominator.
The success run counts consecutive sessions with no gap and at least 99% priced.

## Run it locally

Prerequisites: Node.js 22+, Python 3.12+, and Git.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r scripts/requirements.txt
npm install
python scripts/fetch_market_data.py
npm run dev
```

Open `http://localhost:3000`. Validate the production result with:

```bash
npm test
npm run lint
```

## Deploy and run manually

After this folder is pushed to a GitHub repository:

1. Open the repository on GitHub.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to **Actions → Refresh market data and deploy**.
4. Choose **Run workflow**, keep `main`, and confirm.

The same button is the manual test; it fetches data, commits the JSON, builds the
site, and deploys it without waiting for the cron schedule. No API secret is
required. The workflow needs repository **Actions → General → Workflow
permissions** set to **Read and write permissions** so its data commit can be
pushed.

Git and GitHub are explained for a first-time coder in
[`docs/git-and-github.md`](docs/git-and-github.md).

## Data-source note

`yfinance` is an open-source client for Yahoo's publicly available market-data
interfaces. It is intended here for personal research/monitoring; review Yahoo's
terms before expanding the project or redistributing the data.
