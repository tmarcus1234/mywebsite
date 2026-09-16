/**
 * market-data.js
 * Client-side data access layer for the portfolio dashboard.
 *
 * ARCHITECTURE NOTE (read this before changing how prices are fetched):
 * GitHub Pages is a static host with no server, so this page can never
 * safely hold a market-data API key — anything in frontend JS is public,
 * visible to anyone who opens dev tools. So prices are NOT fetched from
 * the market-data API in the browser. Instead:
 *
 *   1. A scheduled GitHub Action (.github/workflows/update-portfolio.yml)
 *      calls the market-data API server-side once per trading day after
 *      the close, using a key stored in GitHub Secrets (never in code).
 *   2. That Action appends one dated entry to data/portfolio-history.json.
 *   3. This file just reads that JSON. The LATEST entry in the history
 *      file is what the dashboard treats as "current" prices.
 *
 * That means "current price" here means "as of the most recent recorded
 * market close," not intraday-live. This is called out on the dashboard
 * itself ("Market Data Updated: <date>") so it's never misleading.
 *
 * If you later want true intraday prices, do NOT add an API key to this
 * file. Instead, point fetchLivePrices() (stubbed below, unused by
 * default) at a small serverless proxy you control (e.g. a Cloudflare
 * Worker or Vercel Edge Function) that holds the key server-side and
 * forwards quotes to the browser. See the README notes in this repo for
 * a sketch of that setup.
 */

const HOLDINGS_URL = 'data/holdings.json';
const HISTORY_URL = 'data/portfolio-history.json';

const _cache = { holdings: null, history: null };

async function fetchJSON(url) {
  // Cache-bust so edits to holdings.json / a fresh Action commit show up
  // immediately instead of being served from the browser's HTTP cache.
  const res = await fetch(`${url}?_=${Date.now()}`);
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  }
  return res.json();
}

export async function loadHoldings() {
  if (_cache.holdings) return _cache.holdings;
  _cache.holdings = await fetchJSON(HOLDINGS_URL);
  return _cache.holdings;
}

export async function loadHistory() {
  if (_cache.history) return _cache.history;
  _cache.history = await fetchJSON(HISTORY_URL);
  return _cache.history;
}

/** Most recent recorded snapshot, or null if none exist yet (day-1 state). */
export function latestSnapshot(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  return history[history.length - 1];
}

/** The snapshot immediately before the latest one, used for daily-change math. */
export function previousSnapshot(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  return history[history.length - 2];
}

/** Filters the full history array down to a selectable chart time window. */
export function filterByPeriod(history, period) {
  if (!Array.isArray(history) || history.length === 0) return [];
  if (period === 'ALL') return history;

  const latestDate = new Date(`${history[history.length - 1].date}T00:00:00Z`);
  const cutoff = new Date(latestDate);

  switch (period) {
    case '1W': cutoff.setUTCDate(cutoff.getUTCDate() - 7); break;
    case '1M': cutoff.setUTCMonth(cutoff.getUTCMonth() - 1); break;
    case '3M': cutoff.setUTCMonth(cutoff.getUTCMonth() - 3); break;
    case '6M': cutoff.setUTCMonth(cutoff.getUTCMonth() - 6); break;
    case 'YTD': cutoff.setUTCMonth(0, 1); break;
    case '1Y': cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1); break;
    default: return history;
  }

  return history.filter(entry => new Date(`${entry.date}T00:00:00Z`) >= cutoff);
}

/**
 * STUB — not called anywhere by default. Kept here only as the documented
 * extension point described in the note above, for if/when a secure
 * serverless proxy is added for true intraday pricing.
 */
export async function fetchLivePrices(/* tickers */) {
  throw new Error(
    'Live intraday pricing is not configured. This dashboard uses the ' +
    'latest daily snapshot from data/portfolio-history.json by design, ' +
    'to avoid exposing an API key in the browser.'
  );
}
