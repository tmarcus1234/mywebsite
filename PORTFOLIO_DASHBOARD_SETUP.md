# Student Investment Club Portfolio Dashboard — Setup Guide

## 1. Files added to your repo

```
portfolio.html                          ← the dashboard page
data/holdings.json                      ← you edit this (only this)
data/portfolio-history.json             ← the GitHub Action edits this — never edit by hand
js/market-data.js                       ← reads the JSON files, no API keys
js/portfolio.js                         ← all calculations + rendering
js/charts.js                            ← Chart.js wrappers
css/portfolio.css                       ← dashboard-specific styles
scripts/update-portfolio.js             ← runs inside the GitHub Action, fetches prices
.github/workflows/update-portfolio.yml  ← the scheduled Action itself
```

Nothing in your existing `index.html` was changed except adding one nav
link (see step 5) — no other section was touched.

## 2. Get a Twelve Data API key

**Why Twelve Data:** free tier (800 requests/day, 8/minute) comfortably
covers one batched call per trading day; it supports US stocks and ETFs,
historical + current quotes, and returns clean JSON that's easy to use
from a GitHub Action. Alpha Vantage is a reasonable alternative (25
requests/day free) if you ever hit Twelve Data limits, but its lower
daily cap makes Twelve Data the safer default here.

1. Go to https://twelvedata.com/ and click **Get Free API Key**.
2. Sign up, confirm your email.
3. Copy the API key from your dashboard.

**Free tier limits to know:** 800 requests/day, 8 requests/minute. This
project uses exactly **one request per day** (one batched call covering
every ticker + SPY), so you're nowhere near the limit even with 20+
holdings.

## 3. Store the key as a GitHub Secret (never in code)

1. In your repo: **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `TWELVE_DATA_API_KEY`
4. Value: paste the key from step 2.
5. Save.

The key now only exists inside GitHub's encrypted secret store and the
Action's runtime environment — it is never written to a file, never
committed, and never sent to the browser.

## 4. Drop in the files

Copy every file above into the same folder structure in your repo
(`portfolio.html` at the root, next to `index.html`; the rest into their
matching subfolders). Commit and push.

## 5. Add the nav link to `index.html`

Your existing nav has this line:

```html
<a href="#projects" class="hover:text-accent-blue transition-colors">Case Studies</a>
<a href="#education" class="hover:text-accent-blue transition-colors">Education</a>
```

Add a Portfolio link between them:

```html
<a href="#projects" class="hover:text-accent-blue transition-colors">Case Studies</a>
<a href="portfolio.html" class="hover:text-accent-blue transition-colors">Portfolio</a>
<a href="#education" class="hover:text-accent-blue transition-colors">Education</a>
```

That's the only change to `index.html`.

## 6. Run the first snapshot manually

The history file starts empty (`[]`) on purpose — no fabricated data.
To populate it immediately instead of waiting for tonight's scheduled
run:

1. Go to your repo's **Actions** tab.
2. Click **Update Portfolio Snapshot** in the left sidebar.
3. Click **Run workflow → Run workflow**.
4. Wait ~10 seconds, then check that `data/portfolio-history.json` now
   has one entry (refresh the file in GitHub).

Once that's done, `portfolio.html` will show real numbers instead of
the "no market data yet" empty states.

## 7. How to add / remove / update a holding

Edit **only** `data/holdings.json`. Example — adding a new position:

```json
{
  "ticker": "MSFT",
  "company": "Microsoft Corporation",
  "shares": 25,
  "purchasePrice": 420.50,
  "purchaseDate": "2026-09-10",
  "sector": "Technology"
}
```

Add that object to the array, commit, push. It will automatically show
up in the summary cards, the table, both allocation charts, movers, and
stats the next time a snapshot runs (or immediately for cost-basis
figures, which don't need a price). To remove a holding, delete its
object from the array. To update shares after a new buy, just change
the `shares` number (V1 uses average-cost accounting, as scoped).

## 8. How the automation works, end to end

1. Every weekday at 21:30 UTC (safely after the 4:00pm ET close year
   round), GitHub triggers the `update-portfolio.yml` workflow.
2. It runs `scripts/update-portfolio.js` on GitHub's server, with your
   `TWELVE_DATA_API_KEY` injected as an environment variable — never
   exposed to the browser or committed anywhere.
3. That script calls Twelve Data once, for every ticker + SPY in a
   single batched request.
4. It computes each position's market value/profit/return and the
   portfolio totals, using the exact formulas below.
5. If the market was closed (weekend/holiday) or the snapshot already
   ran today, it detects the duplicate trading date and **skips**
   without writing anything.
6. Otherwise it appends one new entry to `data/portfolio-history.json`
   and commits + pushes that one file.
7. The next time anyone visits `portfolio.html`, the page fetches the
   updated JSON and re-renders — no rebuild or redeploy needed.

## 9. How "live" pricing works on a static site (read this)

GitHub Pages has no server, so the page itself can **never** safely
hold an API key — anything in frontend JavaScript is visible to anyone
who opens dev tools. Because of that:

- **Historical chart** → reads `data/portfolio-history.json` directly.
- **"Current" price / value everywhere else** → also reads the *latest
  entry* in that same file (i.e., the most recent recorded market
  close), not a live intraday quote.

The dashboard is explicit about this — it displays "Market Data
Updated: [date] close" rather than implying real-time intraday pricing.
This is the standard, secure architecture for a static-site portfolio
tracker. If you eventually want true intraday prices, the safe path is
adding a small serverless proxy you control (e.g., a Cloudflare Worker)
that holds the key server-side and forwards quotes to the browser —
`js/market-data.js` has a stubbed `fetchLivePrices()` function marked
as the extension point for that, so you don't have to restructure
anything later.

## 10. Calculations used (for your own verification)

```
Cost Basis (position)   = shares × purchasePrice
Market Value (position) = shares × currentPrice
Profit / Loss           = Market Value − Cost Basis
Return %                = (currentPrice − purchasePrice) / purchasePrice × 100
Portfolio Weight        = Position Market Value / Total Portfolio Market Value × 100

Total Cost Basis        = Σ (shares × purchasePrice)
Total Market Value      = Σ (shares × currentPrice)
Total Portfolio Profit  = Total Market Value − Total Cost Basis
Portfolio Return %      = Total Portfolio Profit / Total Cost Basis × 100
```

Portfolio Return % is always profit-over-cost-basis at the portfolio
level — it is never computed by averaging individual holdings' return
percentages.

## 11. Error handling built in

- API/network failure during the Action → script exits without writing;
  no broken or partial snapshot is ever committed.
- A ticker with no quote (invalid/delisted) → excluded from that day's
  totals with a warning logged; the rest of the portfolio still updates.
- Page loads with no history yet → clear "no market data yet" empty
  states instead of crashing or showing zeros.
- JSON fetch fails in the browser → "Market data temporarily
  unavailable" banner instead of a blank/broken page.

## 12. Migrating to a full transaction ledger later

`holdings.json` (average-cost) and `portfolio-history.json` are kept
completely separate from the calculation and rendering code in
`portfolio.js`. When you're ready for buys/sells/dividends/realized
gains, you'd introduce a `transactions.json` ledger and change only the
functions that build `holdings`-equivalent data (`computePositions`'s
inputs) — the summary cards, table, charts, and modal all consume the
same shape of data regardless of how it was derived, so they shouldn't
need to change.
