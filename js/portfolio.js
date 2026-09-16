/**
 * portfolio.js
 * All financial calculations + DOM rendering for the Student Investment
 * Club portfolio dashboard. Data comes from market-data.js; charts are
 * drawn by charts.js. This file wires the two together.
 *
 * CALCULATION RULES (kept centralized here so they're easy to audit):
 *   Cost Basis (position)      = shares × purchasePrice
 *   Market Value (position)    = shares × currentPrice
 *   Profit / Loss (position)   = Market Value − Cost Basis
 *   Return % (position)        = (currentPrice − purchasePrice) / purchasePrice × 100
 *   Portfolio Weight           = Position Market Value / Total Portfolio Market Value × 100
 *
 *   Total Cost Basis           = Σ (shares × purchasePrice)
 *   Total Market Value         = Σ (shares × currentPrice)
 *   Total Portfolio Profit     = Total Market Value − Total Cost Basis
 *   Portfolio Return %         = Total Portfolio Profit / Total Cost Basis × 100
 *
 * Portfolio Return % is NEVER computed by averaging individual position
 * return percentages — it is always profit-over-cost-basis at the
 * portfolio level, per the formula above.
 */

import {
  loadHoldings,
  loadHistory,
  latestSnapshot,
  previousSnapshot,
  filterByPeriod
} from './market-data.js';

import {
  renderPerformanceChart,
  renderAllocationChart,
  renderSectorChart,
  renderTickerHistoryChart,
  destroyTickerHistoryChart
} from './charts.js';

// ---------- formatting helpers ----------

const fmtUSD = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtSignedUSD = (n) => `${n >= 0 ? '+' : '\u2212'}${fmtUSD(Math.abs(n))}`;

// Whole-dollar / whole-percent variants — used only for the six summary
// cards at the top, per request. The table and ticker modal keep exact
// cent-level figures for precision.
const fmtUSDWhole = (n) =>
  Math.round(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtSignedUSDWhole = (n) => `${n >= 0 ? '+' : '\u2212'}${fmtUSDWhole(Math.abs(n))}`;

const fmtPctWhole = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;

const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function signClass(n) {
  if (n > 0) return 'pl-positive';
  if (n < 0) return 'pl-negative';
  return 'pl-flat';
}

function el(id) { return document.getElementById(id); }

// ---------- state ----------

const state = {
  holdings: [],
  history: [],
  positions: [],
  totals: null,
  period: '3M',
  chartMode: 'value', // 'value' | 'return' | 'benchmark'
  sortKey: 'weight',
  sortDir: 'desc'
};

// ---------- calculations ----------

function computePositions(holdings, snapshot, prevSnap) {
  const positions = holdings.map(h => {
    const ticker = h.ticker.toUpperCase();
    const costBasis = round2(h.shares * h.purchasePrice);
    const posData = snapshot && snapshot.positions ? snapshot.positions[ticker] : null;
    const hasPrice = !!(posData && typeof posData.price === 'number');

    const currentPrice = hasPrice ? posData.price : null;
    const marketValue = hasPrice ? round2(h.shares * currentPrice) : null;
    const profit = hasPrice ? round2(marketValue - costBasis) : null;
    const returnPercent = hasPrice ? round2(((currentPrice - h.purchasePrice) / h.purchasePrice) * 100) : null;

    const prevPos = prevSnap && prevSnap.positions ? prevSnap.positions[ticker] : null;
    let dailyChangeDollar = null;
    let dailyChangePercent = null;
    if (hasPrice && prevPos && typeof prevPos.price === 'number' && prevPos.price !== 0) {
      dailyChangeDollar = round2(h.shares * (currentPrice - prevPos.price));
      dailyChangePercent = round2(((currentPrice - prevPos.price) / prevPos.price) * 100);
    }

    return {
      ...h,
      ticker,
      costBasis,
      hasPrice,
      currentPrice,
      marketValue,
      profit,
      returnPercent,
      dailyChangeDollar,
      dailyChangePercent,
      weight: null // filled in below once total market value is known
    };
  });

  const totalMarketValue = positions.reduce((s, p) => s + (p.hasPrice ? p.marketValue : 0), 0);
  positions.forEach(p => {
    p.weight = (p.hasPrice && totalMarketValue > 0) ? round2((p.marketValue / totalMarketValue) * 100) : null;
  });

  return positions;
}

function computeTotals(positions, snapshot, prevSnap) {
  const priced = positions.filter(p => p.hasPrice);
  const missingCount = positions.length - priced.length;

  const totalCostBasis = round2(priced.reduce((s, p) => s + p.costBasis, 0));
  const totalMarketValue = round2(priced.reduce((s, p) => s + p.marketValue, 0));
  const totalProfit = round2(totalMarketValue - totalCostBasis);
  const totalReturnPercent = totalCostBasis > 0 ? round2((totalProfit / totalCostBasis) * 100) : 0;

  let dailyChangeDollar = null;
  let dailyChangePercent = null;
  if (snapshot && prevSnap && typeof prevSnap.portfolioValue === 'number' && prevSnap.portfolioValue !== 0) {
    dailyChangeDollar = round2(snapshot.portfolioValue - prevSnap.portfolioValue);
    dailyChangePercent = round2((dailyChangeDollar / prevSnap.portfolioValue) * 100);
  }

  return {
    totalCostBasis,
    totalMarketValue,
    totalProfit,
    totalReturnPercent,
    dailyChangeDollar,
    dailyChangePercent,
    missingCount,
    holdingsCount: positions.length
  };
}

function computeAllocation(positions) {
  return positions
    .filter(p => p.hasPrice && p.marketValue > 0)
    .map(p => ({ label: p.ticker, value: p.marketValue, weight: p.weight }))
    .sort((a, b) => b.value - a.value);
}

function computeSectorAllocation(positions) {
  const map = new Map();
  positions.filter(p => p.hasPrice && p.marketValue > 0).forEach(p => {
    const sector = p.sector || 'Other';
    map.set(sector, (map.get(sector) || 0) + p.marketValue);
  });
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  return [...map.entries()]
    .map(([label, value]) => ({ label, value, weight: total > 0 ? round2((value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
}

function computeMovers(positions) {
  const priced = positions.filter(p => p.hasPrice);

  const top = [...priced]
    .sort((a, b) => b.returnPercent - a.returnPercent)
    .slice(0, Math.min(3, priced.length));

  // Decliners are only ever actual losses — never "the least-positive
  // positions" when the whole portfolio happens to be up.
  const bottom = priced
    .filter(p => p.returnPercent < 0)
    .sort((a, b) => a.returnPercent - b.returnPercent)
    .slice(0, 3);

  return { top, bottom, hasPriced: priced.length > 0 };
}

function computeStats(positions) {
  const priced = positions.filter(p => p.hasPrice);
  if (priced.length === 0) return null;

  const best = priced.reduce((a, b) => (b.returnPercent > a.returnPercent ? b : a));
  const worst = priced.reduce((a, b) => (b.returnPercent < a.returnPercent ? b : a));
  const largest = priced.reduce((a, b) => (b.marketValue > a.marketValue ? b : a));
  const smallest = priced.reduce((a, b) => (b.marketValue < a.marketValue ? b : a));
  const avgReturn = round2(priced.reduce((s, p) => s + p.returnPercent, 0) / priced.length);
  const winners = priced.filter(p => p.profit > 0).length;
  const losers = priced.filter(p => p.profit < 0).length;

  return { best, worst, largest, smallest, avgReturn, winners, losers };
}

function computeBenchmark(history) {
  const withSpy = history.filter(h => typeof h.spyClose === 'number' && typeof h.returnPercent === 'number');
  if (withSpy.length < 2) return null;

  const baseSpy = withSpy[0].spyClose;
  if (!baseSpy) return null;

  // Portfolio side is indexed off Total Return % (profit/cost-basis), NOT
  // raw dollar value. Raw value would spike whenever a new holding is
  // added — that's new capital entering the portfolio, not investment
  // performance — and would badly distort the comparison against a
  // static benchmark like SPY. Return % already isolates real gains from
  // contributions, since cost basis grows alongside market value the
  // instant a new position joins.
  const series = withSpy.map(h => ({
    date: h.date,
    portfolioNorm: round2(100 + h.returnPercent),
    spyNorm: round2((h.spyClose / baseSpy) * 100)
  }));

  const last = series[series.length - 1];
  const portfolioReturn = round2(last.portfolioNorm - 100);
  const spyReturn = round2(last.spyNorm - 100);
  const relative = round2(portfolioReturn - spyReturn);

  return { series, portfolioReturn, spyReturn, relative, startDate: withSpy[0].date };
}

// ---------- rendering ----------

function renderDataStatus(snapshot) {
  const banner = el('data-status');
  if (!snapshot) {
    banner.innerHTML = `
      <span class="pl-negative font-medium">No market data yet.</span>
      <span class="text-muted"> The first snapshot is recorded automatically after the next trading day's close
      (or run the "Update Portfolio Snapshot" GitHub Action manually to backfill today).</span>`;
    return;
  }
  const asOf = new Date(`${snapshot.date}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  banner.innerHTML = `
    <span class="text-primary font-medium">Market Data Updated:</span>
    <span class="text-muted"> ${asOf} close.</span>
    <span class="text-muted">Prices reflect the most recent recorded market close, not intraday trading.</span>`;
}

function renderSummaryCards(totals) {
  el('card-value').textContent = fmtUSDWhole(totals.totalMarketValue);
  el('card-cost-basis').textContent = fmtUSDWhole(totals.totalCostBasis);

  const profitEl = el('card-profit');
  profitEl.textContent = fmtSignedUSDWhole(totals.totalProfit);
  profitEl.className = `font-mono text-lg sm:text-xl lg:text-2xl font-semibold break-words ${signClass(totals.totalProfit)}`;

  const returnEl = el('card-return');
  returnEl.textContent = fmtPctWhole(totals.totalReturnPercent);
  returnEl.className = `font-mono text-lg sm:text-xl lg:text-2xl font-semibold break-words ${signClass(totals.totalReturnPercent)}`;

  const dailyDollarEl = el('card-daily-dollar');
  const dailyPctEl = el('card-daily-pct');
  if (totals.dailyChangeDollar === null) {
    dailyDollarEl.textContent = '—';
    dailyPctEl.textContent = 'No prior session yet';
    dailyDollarEl.className = 'font-mono text-lg sm:text-xl lg:text-2xl font-semibold break-words text-muted';
    dailyPctEl.className = 'text-xs text-muted mt-1';
  } else {
    dailyDollarEl.textContent = fmtSignedUSDWhole(totals.dailyChangeDollar);
    dailyPctEl.textContent = `${fmtPctWhole(totals.dailyChangePercent)} Today`;
    dailyDollarEl.className = `font-mono text-lg sm:text-xl lg:text-2xl font-semibold break-words ${signClass(totals.dailyChangeDollar)}`;
    dailyPctEl.className = `text-xs mt-1 font-mono ${signClass(totals.dailyChangePercent)}`;
  }

  el('card-holdings').textContent = totals.holdingsCount;

  const missingNote = el('missing-data-note');
  if (totals.missingCount > 0) {
    missingNote.classList.remove('hidden');
    missingNote.textContent = `Market data temporarily unavailable for ${totals.missingCount} holding(s); totals above exclude ${totals.missingCount === 1 ? 'it' : 'them'} until the next snapshot.`;
  } else {
    missingNote.classList.add('hidden');
  }
}

function tableRowHTML(p) {
  const priced = p.hasPrice;
  return `
    <tr class="border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer" data-ticker="${p.ticker}">
      <td class="py-3 px-4">
        <p class="text-primary font-medium">${p.company}</p>
        <p class="text-xs text-muted font-mono">${p.sector}</p>
      </td>
      <td class="py-3 px-4 font-mono text-accent-gold">${p.ticker}</td>
      <td class="py-3 px-4 font-mono text-muted text-right">${p.shares}</td>
      <td class="py-3 px-4 font-mono text-muted text-right">${fmtUSD(p.purchasePrice)}</td>
      <td class="py-3 px-4 font-mono text-right">${priced ? fmtUSD(p.currentPrice) : '<span class="text-muted">—</span>'}</td>
      <td class="py-3 px-4 font-mono text-muted text-right">${fmtUSD(p.costBasis)}</td>
      <td class="py-3 px-4 font-mono text-right">${priced ? fmtUSD(p.marketValue) : '<span class="text-muted">—</span>'}</td>
      <td class="py-3 px-4 font-mono text-right ${priced ? signClass(p.profit) : ''}">${priced ? fmtSignedUSD(p.profit) : '—'}</td>
      <td class="py-3 px-4 font-mono text-right ${priced ? signClass(p.returnPercent) : ''}">${priced ? fmtPct(p.returnPercent) : '—'}</td>
      <td class="py-3 px-4 font-mono text-right ${p.dailyChangePercent !== null ? signClass(p.dailyChangePercent) : ''}">${p.dailyChangePercent !== null ? fmtPct(p.dailyChangePercent) : '—'}</td>
      <td class="py-3 px-4 font-mono text-right">${p.weight !== null ? `${p.weight.toFixed(1)}%` : '—'}</td>
    </tr>`;
}

function cardHTML(p) {
  const priced = p.hasPrice;
  return `
    <div class="surface border border-white/10 rounded-2xl p-5 cursor-pointer lift" data-ticker="${p.ticker}">
      <div class="flex items-start justify-between mb-3">
        <div>
          <p class="font-mono text-accent-gold text-sm">${p.ticker}</p>
          <p class="text-primary font-medium">${p.company}</p>
        </div>
        <p class="text-xs text-muted font-mono">${p.weight !== null ? `${p.weight.toFixed(1)}% wt.` : ''}</p>
      </div>
      <div class="grid grid-cols-2 gap-y-2 text-sm">
        <p class="text-muted">Shares</p><p class="text-right font-mono text-muted">${p.shares}</p>
        <p class="text-muted">Avg Cost</p><p class="text-right font-mono text-muted">${fmtUSD(p.purchasePrice)}</p>
        <p class="text-muted">Price</p><p class="text-right font-mono">${priced ? fmtUSD(p.currentPrice) : '—'}</p>
        <p class="text-muted">Value</p><p class="text-right font-mono">${priced ? fmtUSD(p.marketValue) : '—'}</p>
        <p class="text-muted">Total P/L</p><p class="text-right font-mono ${priced ? signClass(p.profit) : ''}">${priced ? `${fmtSignedUSD(p.profit)} (${fmtPct(p.returnPercent)})` : '—'}</p>
        <p class="text-muted">Today</p><p class="text-right font-mono ${p.dailyChangePercent !== null ? signClass(p.dailyChangePercent) : ''}">${p.dailyChangePercent !== null ? fmtPct(p.dailyChangePercent) : '—'}</p>
      </div>
    </div>`;
}

const SORT_ACCESSORS = {
  ticker: p => p.ticker,
  sector: p => p.sector,
  weight: p => (p.weight ?? -Infinity),
  marketValue: p => (p.marketValue ?? -Infinity),
  returnPercent: p => (p.returnPercent ?? -Infinity),
  profit: p => (p.profit ?? -Infinity),
  dailyChangePercent: p => (p.dailyChangePercent ?? -Infinity)
};

function sortedPositions() {
  const accessor = SORT_ACCESSORS[state.sortKey] || SORT_ACCESSORS.weight;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return [...state.positions].sort((a, b) => {
    const av = accessor(a), bv = accessor(b);
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

function renderTable() {
  const rows = sortedPositions();
  el('holdings-tbody').innerHTML = rows.map(tableRowHTML).join('');
  el('holdings-cards').innerHTML = rows.map(cardHTML).join('');

  document.querySelectorAll('[data-sort-indicator]').forEach(node => {
    node.textContent = node.dataset.sortIndicator === state.sortKey
      ? (state.sortDir === 'asc' ? '▲' : '▼')
      : '';
  });

  // Click-to-open ticker detail on both table rows and mobile cards.
  document.querySelectorAll('[data-ticker]').forEach(node => {
    node.addEventListener('click', () => openTickerModal(node.dataset.ticker));
  });
}

function moverRowHTML(p) {
  return `
    <div class="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span class="font-mono text-sm text-primary">${p.ticker}</span>
      <span class="font-mono text-sm ${signClass(p.returnPercent)}">${fmtPct(p.returnPercent)}</span>
    </div>`;
}

function renderMovers(positions) {
  const { top, bottom, hasPriced } = computeMovers(positions);
  el('top-performers').innerHTML = top.length
    ? top.map(moverRowHTML).join('')
    : '<p class="text-sm text-muted">Not enough priced positions yet.</p>';
  el('largest-decliners').innerHTML = bottom.length
    ? bottom.map(moverRowHTML).join('')
    : `<p class="text-sm text-muted">${hasPriced ? 'No positions currently down.' : 'Not enough priced positions yet.'}</p>`;
}

function renderStats(positions) {
  const stats = computeStats(positions);
  const container = el('portfolio-stats');
  if (!stats) {
    container.innerHTML = '<p class="text-sm text-muted">Stats will appear once the first price snapshot is recorded.</p>';
    return;
  }
  const rows = [
    ['Best Performer', `${stats.best.ticker} · ${fmtPct(stats.best.returnPercent)}`, signClass(stats.best.returnPercent)],
    ['Worst Performer', `${stats.worst.ticker} · ${fmtPct(stats.worst.returnPercent)}`, signClass(stats.worst.returnPercent)],
    ['Largest Position', `${stats.largest.ticker} · ${fmtUSD(stats.largest.marketValue)}`, ''],
    ['Smallest Position', `${stats.smallest.ticker} · ${fmtUSD(stats.smallest.marketValue)}`, ''],
    ['Avg. Position Return (equal-wtd)', fmtPct(stats.avgReturn), signClass(stats.avgReturn)],
    ['Profitable / Losing Positions', `${stats.winners} / ${stats.losers}`, '']
  ];
  container.innerHTML = rows.map(([label, value, cls]) => `
    <div class="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span class="text-sm text-muted">${label}</span>
      <span class="text-sm font-mono ${cls}">${value}</span>
    </div>`).join('');
}

function renderBenchmark(history) {
  const bench = computeBenchmark(history);
  const section = el('benchmark-section');
  if (!bench) {
    section.innerHTML = '<p class="text-sm text-muted">Benchmark comparison unlocks once at least two daily snapshots include an SPY close.</p>';
    return;
  }
  const startLabel = new Date(`${bench.startDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  section.innerHTML = `
    <div class="grid grid-cols-3 gap-4 text-center">
      <div>
        <p class="text-xs text-muted uppercase eyebrow font-mono mb-1">Portfolio Return</p>
        <p class="font-mono text-xl font-semibold ${signClass(bench.portfolioReturn)}">${fmtPct(bench.portfolioReturn)}</p>
      </div>
      <div>
        <p class="text-xs text-muted uppercase eyebrow font-mono mb-1">S&amp;P 500 Return</p>
        <p class="font-mono text-xl font-semibold ${signClass(bench.spyReturn)}">${fmtPct(bench.spyReturn)}</p>
      </div>
      <div>
        <p class="text-xs text-muted uppercase eyebrow font-mono mb-1">Relative Performance</p>
        <p class="font-mono text-xl font-semibold ${signClass(bench.relative)}">${bench.relative >= 0 ? '+' : ''}${bench.relative.toFixed(2)} pp</p>
      </div>
    </div>
    <p class="text-xs text-muted mt-4 text-center">Both series indexed to 100 starting ${startLabel}, the date tracking began. Figures are not fabricated prior to this date.</p>`;
}

// ---------- ticker detail modal ----------

function openTickerModal(ticker) {
  const p = state.positions.find(x => x.ticker === ticker);
  if (!p) return;

  el('modal-company').textContent = p.company.toUpperCase();
  el('modal-ticker').textContent = p.ticker;
  el('modal-current-price').textContent = p.hasPrice ? fmtUSD(p.currentPrice) : '—';
  el('modal-avg-price').textContent = fmtUSD(p.purchasePrice);
  el('modal-shares').textContent = p.shares;
  el('modal-cost-basis').textContent = fmtUSD(p.costBasis);
  el('modal-market-value').textContent = p.hasPrice ? fmtUSD(p.marketValue) : '—';

  const profitEl = el('modal-profit');
  profitEl.textContent = p.hasPrice ? fmtSignedUSD(p.profit) : '—';
  profitEl.className = `font-mono text-lg font-semibold ${p.hasPrice ? signClass(p.profit) : ''}`;

  const returnEl = el('modal-return');
  returnEl.textContent = p.hasPrice ? fmtPct(p.returnPercent) : '—';
  returnEl.className = `font-mono text-lg font-semibold ${p.hasPrice ? signClass(p.returnPercent) : ''}`;

  el('modal-weight').textContent = p.weight !== null ? `${p.weight.toFixed(1)}%` : '—';
  el('modal-purchase-date').textContent = p.purchaseDate || '—';
  el('modal-sector').textContent = p.sector;

  const tickerHistory = state.history
    .filter(h => h.positions && h.positions[p.ticker])
    .map(h => ({ date: h.date, value: h.positions[p.ticker].marketValue }));

  const chartWrap = el('modal-chart-wrap');
  if (tickerHistory.length >= 2) {
    chartWrap.classList.remove('hidden');
    renderTickerHistoryChart('modal-chart', tickerHistory);
  } else {
    chartWrap.classList.add('hidden');
    destroyTickerHistoryChart();
  }

  el('ticker-modal').classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
}

function closeTickerModal() {
  el('ticker-modal').classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
  destroyTickerHistoryChart();
}

// ---------- main refresh ----------

function refreshAll() {
  const snapshot = latestSnapshot(state.history);
  const prevSnap = previousSnapshot(state.history);

  state.positions = computePositions(state.holdings, snapshot, prevSnap);
  state.totals = computeTotals(state.positions, snapshot, prevSnap);

  renderDataStatus(snapshot);
  renderSummaryCards(state.totals);
  renderTable();
  renderMovers(state.positions);
  renderStats(state.positions);
  renderBenchmark(state.history);

  renderAllocationChart('allocation-chart', computeAllocation(state.positions));
  renderSectorChart('sector-chart', computeSectorAllocation(state.positions));

  const periodData = filterByPeriod(state.history, state.period);
  renderPerformanceChart('performance-chart', periodData, state.chartMode);
}

// ---------- event wiring ----------

function wireControls() {
  document.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.period = btn.dataset.period;
      document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderPerformanceChart('performance-chart', filterByPeriod(state.history, state.period), state.chartMode);
    });
  });

  document.querySelectorAll('[data-chart-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.chartMode = btn.dataset.chartMode;
      document.querySelectorAll('[data-chart-mode]').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderPerformanceChart('performance-chart', filterByPeriod(state.history, state.period), state.chartMode);
    });
  });

  document.querySelectorAll('[data-sort-key]').forEach(header => {
    header.addEventListener('click', () => {
      const key = header.dataset.sortKey;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'desc';
      }
      renderTable();
    });
  });

  el('modal-close').addEventListener('click', closeTickerModal);
  el('ticker-modal').addEventListener('click', (e) => {
    if (e.target.id === 'ticker-modal') closeTickerModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTickerModal();
  });
}

// ---------- boot ----------

async function init() {
  wireControls();
  try {
    const [holdings, history] = await Promise.all([loadHoldings(), loadHistory()]);
    state.holdings = holdings;
    state.history = history;
    refreshAll();
  } catch (err) {
    console.error('Dashboard failed to load market data:', err);
    el('data-status').innerHTML =
      '<span class="pl-negative font-medium">Market data temporarily unavailable.</span> ' +
      '<span class="text-muted">Displaying most recently available prices was not possible — please refresh shortly.</span>';
  }
}

document.addEventListener('DOMContentLoaded', init);
