/**
 * charts.js
 * Thin wrappers around Chart.js for the four charts on the dashboard:
 *   - Main portfolio performance line chart (value / return% / vs SPY)
 *   - Position allocation donut
 *   - Sector allocation donut
 *   - Per-ticker market-value history (shown in the ticker detail modal)
 *
 * Chart.js is loaded globally via <script> in portfolio.html, so `Chart`
 * is available as a global here — no bundler needed, keeping this
 * GitHub-Pages-friendly.
 */

let performanceChart = null;
let allocationChart = null;
let sectorChart = null;
let tickerChart = null;

const PALETTE = ['#5B8DEF', '#C9A24B', '#34D399', '#F87171', '#A78BFA', '#38BDF8', '#FB923C', '#F472B6', '#94A3B8', '#22D3EE'];

function getCssColor(varClass, prop = 'color') {
  const probe = document.createElement('span');
  probe.className = varClass;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const value = getComputedStyle(probe)[prop];
  document.body.removeChild(probe);
  return value;
}

function fmtDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function renderPerformanceChart(canvasId, history, mode) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const empty = document.getElementById('performance-empty');
  if (!history || history.length === 0) {
    ctx.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    if (performanceChart) { performanceChart.destroy(); performanceChart = null; }
    return;
  }
  ctx.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  const labels = history.map(h => fmtDate(h.date));
  const gridColor = 'rgba(148,163,184,0.12)';
  const mutedColor = getCssColor('text-muted') || '#94A3B8';
  const blue = '#5B8DEF';
  const gold = '#C9A24B';

  let datasets;
  let yTickFormat = (v) => `$${(v / 1000).toFixed(0)}k`;
  let tooltipExtra = (i) => {
    const h = history[i];
    return [`Profit: ${h.profit >= 0 ? '+' : ''}$${h.profit.toLocaleString()}`, `Return: ${h.returnPercent >= 0 ? '+' : ''}${h.returnPercent.toFixed(2)}%`];
  };

  if (mode === 'return') {
    datasets = [{
      label: 'Total Return %',
      data: history.map(h => h.returnPercent),
      borderColor: blue,
      backgroundColor: 'rgba(91,141,239,0.12)',
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 5
    }];
    yTickFormat = (v) => `${v.toFixed(0)}%`;
  } else if (mode === 'benchmark') {
    const withSpy = history.filter(h => typeof h.spyClose === 'number');
    if (withSpy.length < 2) {
      ctx.classList.add('hidden');
      if (empty) {
        empty.textContent = 'Benchmark comparison needs at least two snapshots with an SPY close.';
        empty.classList.remove('hidden');
      }
      if (performanceChart) { performanceChart.destroy(); performanceChart = null; }
      return;
    }
    const baseP = withSpy[0].portfolioValue, baseS = withSpy[0].spyClose;
    datasets = [
      {
        label: 'Student Investment Club',
        data: withSpy.map(h => (h.portfolioValue / baseP) * 100),
        borderColor: gold,
        backgroundColor: 'rgba(201,162,75,0.1)',
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5
      },
      {
        label: 'S&P 500 (SPY)',
        data: withSpy.map(h => (h.spyClose / baseS) * 100),
        borderColor: mutedColor,
        borderDash: [6, 4],
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5
      }
    ];
    yTickFormat = (v) => v.toFixed(0);
    tooltipExtra = () => [];
  } else {
    datasets = [{
      label: 'Portfolio Value',
      data: history.map(h => h.portfolioValue),
      borderColor: blue,
      backgroundColor: 'rgba(91,141,239,0.12)',
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 5
    }];
  }

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: mutedColor, font: { family: 'IBM Plex Mono', size: 11 } } },
        tooltip: {
          backgroundColor: '#0F1D33',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#F5F7FA',
          bodyColor: '#94A3B8',
          padding: 12,
          callbacks: {
            afterBody: (items) => tooltipExtra(items[0].dataIndex)
          }
        }
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: mutedColor, font: { family: 'IBM Plex Mono', size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: gridColor }, ticks: { color: mutedColor, font: { family: 'IBM Plex Mono', size: 10 }, callback: yTickFormat } }
      }
    }
  };

  if (performanceChart) {
    performanceChart.data = config.data;
    performanceChart.options = config.options;
    performanceChart.update();
  } else {
    performanceChart = new Chart(ctx, config);
  }
}

function donutConfig(items, mutedColor) {
  return {
    type: 'doughnut',
    data: {
      labels: items.map(i => i.label),
      datasets: [{
        data: items.map(i => i.value),
        backgroundColor: items.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: '#0F1D33',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'right',
          labels: { color: mutedColor, font: { family: 'IBM Plex Mono', size: 11 }, boxWidth: 10, padding: 12 }
        },
        tooltip: {
          backgroundColor: '#0F1D33',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#F5F7FA',
          bodyColor: '#94A3B8',
          callbacks: {
            label: (ctx) => {
              const item = items[ctx.dataIndex];
              return ` ${item.label}: ${item.weight.toFixed(1)}%`;
            }
          }
        }
      }
    }
  };
}

export function renderAllocationChart(canvasId, items) {
  const ctx = document.getElementById(canvasId);
  const empty = document.getElementById('allocation-empty');
  if (!ctx) return;
  if (!items || items.length === 0) {
    ctx.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    if (allocationChart) { allocationChart.destroy(); allocationChart = null; }
    return;
  }
  ctx.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');
  const mutedColor = getCssColor('text-muted') || '#94A3B8';
  if (allocationChart) allocationChart.destroy();
  allocationChart = new Chart(ctx, donutConfig(items, mutedColor));
}

export function renderSectorChart(canvasId, items) {
  const ctx = document.getElementById(canvasId);
  const empty = document.getElementById('sector-empty');
  if (!ctx) return;
  if (!items || items.length === 0) {
    ctx.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    if (sectorChart) { sectorChart.destroy(); sectorChart = null; }
    return;
  }
  ctx.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');
  const mutedColor = getCssColor('text-muted') || '#94A3B8';
  if (sectorChart) sectorChart.destroy();
  sectorChart = new Chart(ctx, donutConfig(items, mutedColor));
}

export function renderTickerHistoryChart(canvasId, points) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const mutedColor = getCssColor('text-muted') || '#94A3B8';
  if (tickerChart) tickerChart.destroy();
  tickerChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => fmtDate(p.date)),
      datasets: [{
        data: points.map(p => p.value),
        borderColor: '#C9A24B',
        backgroundColor: 'rgba(201,162,75,0.12)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: mutedColor, font: { family: 'IBM Plex Mono', size: 9 }, maxTicksLimit: 5 } },
        y: { grid: { color: 'rgba(148,163,184,0.12)' }, ticks: { color: mutedColor, font: { family: 'IBM Plex Mono', size: 9 }, callback: (v) => `$${(v / 1000).toFixed(1)}k` } }
      }
    }
  });
}

export function destroyTickerHistoryChart() {
  if (tickerChart) { tickerChart.destroy(); tickerChart = null; }
}
