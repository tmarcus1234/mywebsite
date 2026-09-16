#!/usr/bin/env node
/**
 * backfill-history.js
 * One-time (or occasional) backfill of data/portfolio-history.json using
 * REAL historical closing prices — never fabricated, and never extended
 * further back than each holding's own purchaseDate. A holding purchased
 * on 2026-09-10 will not appear in, or count toward, any day before that.
 *
 * This is what makes it honest rather than a fabricated performance
 * history: every number here reflects prices that actually occurred, for
 * dates the club actually held the position.
 *
 * Run manually via the "Backfill Portfolio History" GitHub Action —
 * this is NOT scheduled, since it's meant to be run occasionally (e.g.
 * after adding a new holding with an older purchase date), not daily.
 * The regular update-portfolio.js workflow keeps appending new days on
 * top of whatever this script produces.
 *
 * Requires TWELVE_DATA_API_KEY (same secret as the daily workflow).
 */

const fs = require('fs');
const path = require('path');

const HOLDINGS_PATH = path.join(__dirname, '..', 'data', 'holdings.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'portfolio-history.json');
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const BENCHMARK_SYMBOL = 'SPY';

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Returns { 'YYYY-MM-DD': closePrice, ... } for one symbol over a date range. */
async function fetchTimeSeries(symbol, startDate, endDate) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${startDate}&end_date=${endDate}&outputsize=5000&apikey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data request failed for ${symbol}: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.status === 'error' || !Array.isArray(data.values)) {
    throw new Error(`No historical data for ${symbol}: ${data.message || 'unknown error (possibly invalid/delisted ticker)'}`);
  }
  const byDate = {};
  data.values.forEach(v => {
    const price = parseFloat(v.close);
    if (!Number.isNaN(price)) byDate[v.datetime] = price;
  });
  return byDate;
}

async function main() {
  if (!API_KEY) {
    console.error('TWELVE_DATA_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');
    process.exit(1);
  }

  const holdings = JSON.parse(fs.readFileSync(HOLDINGS_PATH, 'utf8'));
  if (!Array.isArray(holdings) || holdings.length === 0) {
    console.error('No holdings found in data/holdings.json.');
    process.exit(1);
  }

  const earliestPurchase = holdings.reduce(
    (min, h) => (h.purchaseDate < min ? h.purchaseDate : min),
    holdings[0].purchaseDate
  );
  const endDate = new Date().toISOString().slice(0, 10);

  console.log(`Backfilling from ${earliestPurchase} (earliest holding's purchase date) through ${endDate}.`);
  console.log('No position will be counted before its own purchase date — this is real historical data, not a projection.');

  const tickers = [...new Set(holdings.map(h => h.ticker.toUpperCase()))];
  const allSymbols = [...tickers, BENCHMARK_SYMBOL];

  const priceSeries = {};
  for (const symbol of allSymbols) {
    try {
      priceSeries[symbol] = await fetchTimeSeries(symbol, earliestPurchase, endDate);
      console.log(`Fetched ${Object.keys(priceSeries[symbol]).length} trading days for ${symbol}.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1); // Don't write a partial/inconsistent backfill.
    }
  }

  // SPY trades every US market session, so its date set is the reliable
  // trading calendar to iterate over (handles weekends/holidays for free).
  const tradingDates = Object.keys(priceSeries[BENCHMARK_SYMBOL]).sort();

  const history = [];
  for (const date of tradingDates) {
    const activeHoldings = holdings.filter(h => h.purchaseDate <= date);
    if (activeHoldings.length === 0) continue; // Before any position existed — skip, don't fabricate.

    let costBasis = 0;
    let marketValue = 0;
    let incomplete = false;
    const positions = {};

    for (const h of activeHoldings) {
      const ticker = h.ticker.toUpperCase();
      const price = priceSeries[ticker] ? priceSeries[ticker][date] : undefined;
      const cb = round2(h.shares * h.purchasePrice);
      costBasis += cb;
      if (price === undefined) {
        incomplete = true; // Missing a price for an active holding on this date.
        continue;
      }
      const mv = round2(h.shares * price);
      const profit = round2(mv - cb);
      const returnPercent = round2((profit / cb) * 100);
      marketValue += mv;
      positions[ticker] = { price, marketValue: mv, profit, returnPercent };
    }

    if (incomplete) {
      console.warn(`Skipping ${date}: missing a price for an active holding that day.`);
      continue;
    }

    costBasis = round2(costBasis);
    marketValue = round2(marketValue);
    const profit = round2(marketValue - costBasis);
    const returnPercent = costBasis > 0 ? round2((profit / costBasis) * 100) : 0;

    history.push({
      date,
      portfolioValue: marketValue,
      costBasis,
      profit,
      returnPercent,
      spyClose: priceSeries[BENCHMARK_SYMBOL][date],
      positions
    });
  }

  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`Wrote ${history.length} real historical trading days to data/portfolio-history.json.`);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
