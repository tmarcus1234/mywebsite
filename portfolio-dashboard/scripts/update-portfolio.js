#!/usr/bin/env node
/**
 * update-portfolio.js
 * Runs inside GitHub Actions (see .github/workflows/update-portfolio.yml),
 * never in the browser. Fetches end-of-day closing prices for every
 * ticker in data/holdings.json plus the SPY benchmark, computes the
 * day's portfolio snapshot, and appends it to data/portfolio-history.json.
 *
 * Requires the TWELVE_DATA_API_KEY environment variable, which the
 * workflow supplies from GitHub Secrets. This script never writes that
 * key to disk or to any committed file.
 *
 * Duplicate-run / market-holiday handling: rather than hardcoding a
 * holiday calendar, this script trusts the market itself — it reads the
 * benchmark quote's own trading date, and skips writing if that date is
 * already the last entry in the history file. That covers weekends,
 * holidays, and accidental re-runs on the same day without extra logic.
 */

const fs = require('fs');
const path = require('path');

const HOLDINGS_PATH = path.join(__dirname, '..', 'data', 'holdings.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'portfolio-history.json');
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const BENCHMARK_SYMBOL = 'SPY';

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Twelve Data's /quote endpoint accepts a comma-separated symbol list in
 * one request (one API call regardless of holding count), returning a
 * single object when one symbol is requested and an object keyed by
 * symbol when several are.
 */
async function fetchQuotes(symbols) {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const quotes = symbols.length === 1 ? { [symbols[0]]: data } : data;

  const results = {};
  for (const symbol of symbols) {
    const q = quotes[symbol];
    if (!q || q.status === 'error' || q.code) {
      console.warn(`No usable quote for ${symbol}: ${(q && q.message) || 'unknown error (possibly invalid/delisted ticker)'}`);
      results[symbol] = null;
      continue;
    }
    const price = parseFloat(q.close);
    if (!price || Number.isNaN(price)) {
      console.warn(`Missing/invalid close price for ${symbol}`);
      results[symbol] = null;
      continue;
    }
    results[symbol] = { price, tradingDate: (q.datetime || '').slice(0, 10) };
  }
  return results;
}

async function main() {
  if (!API_KEY) {
    console.error('TWELVE_DATA_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');
    process.exit(1);
  }

  const holdings = readJSON(HOLDINGS_PATH, []);
  if (!Array.isArray(holdings) || holdings.length === 0) {
    console.error('No holdings found in data/holdings.json. Nothing to snapshot.');
    process.exit(1);
  }

  const history = readJSON(HISTORY_PATH, []);
  const tickers = holdings.map(h => h.ticker.toUpperCase());
  const allSymbols = [...new Set([...tickers, BENCHMARK_SYMBOL])];

  let quotes;
  try {
    quotes = await fetchQuotes(allSymbols);
  } catch (err) {
    // Network problem / rate limit / API outage: exit without writing so
    // we never commit a partial or fabricated snapshot.
    console.error('Market data fetch failed:', err.message);
    process.exit(1);
  }

  const spyQuote = quotes[BENCHMARK_SYMBOL];
  if (!spyQuote) {
    console.error('Could not resolve a trading date (SPY quote unavailable). Aborting without writing.');
    process.exit(1);
  }
  const tradingDate = spyQuote.tradingDate || new Date().toISOString().slice(0, 10);

  const lastEntry = history[history.length - 1];
  if (lastEntry && lastEntry.date === tradingDate) {
    console.log(`Snapshot for ${tradingDate} is already recorded (market closed/holiday, or already run today). Skipping.`);
    return;
  }

  let totalCostBasis = 0;
  let totalMarketValue = 0;
  const positions = {};
  let hadMissingPrice = false;

  for (const h of holdings) {
    const ticker = h.ticker.toUpperCase();
    const quote = quotes[ticker];
    const costBasis = round2(h.shares * h.purchasePrice);

    if (!quote) {
      hadMissingPrice = true;
      console.warn(`Excluding ${ticker} from today's totals: no price available.`);
      continue; // Never guess a price — leave it out rather than distort totals.
    }

    const marketValue = round2(h.shares * quote.price);
    const profit = round2(marketValue - costBasis);
    const returnPercent = round2((profit / costBasis) * 100);

    totalCostBasis += costBasis;
    totalMarketValue += marketValue;
    positions[ticker] = { price: quote.price, marketValue, profit, returnPercent };
  }

  if (hadMissingPrice) {
    console.warn('One or more tickers were missing price data; totals reflect only successfully priced positions.');
  }

  const totalProfit = round2(totalMarketValue - totalCostBasis);
  const totalReturnPercent = totalCostBasis > 0 ? round2((totalProfit / totalCostBasis) * 100) : 0;

  const snapshot = {
    date: tradingDate,
    portfolioValue: round2(totalMarketValue),
    costBasis: round2(totalCostBasis),
    profit: totalProfit,
    returnPercent: totalReturnPercent,
    spyClose: spyQuote.price,
    positions
  };

  history.push(snapshot);
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`Recorded snapshot for ${tradingDate}: portfolio value $${snapshot.portfolioValue}, return ${snapshot.returnPercent}%`);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
