const SYMBOLS = {
  BTCUSDT: { name: "Bitcoin", price: 118420, digits: 2, market: "crypto" },
  ETHUSDT: { name: "Ethereum", price: 3560, digits: 2, market: "crypto" },
  EURUSD: { name: "Euro / Dollar", price: 1.1684, digits: 5, market: "forex" },
  GBPUSD: { name: "Pound / Dollar", price: 1.3421, digits: 5, market: "forex" },
  XAUUSD: { name: "Gold", price: 3340.5, digits: 2, market: "forex" },
  NAS100: { name: "Nasdaq 100", price: 23180, digits: 1, market: "index" },
};

const state = {
  symbol: "BTCUSDT",
  interval: "15m",
  candles: [],
  analysis: null,
};

const $ = (id) => document.getElementById(id);

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const char of seedText) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRandom(random) {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function generateCandles(symbol, interval, limit = 120) {
  const info = SYMBOLS[symbol];
  const hourSeed = Math.floor(Date.now() / 3600000);
  const random = seededRandom(`${symbol}:${interval}:${hourSeed}`);

  let volatility = info.market === "crypto" ? 0.004 : 0.0015;
  if (symbol === "XAUUSD") volatility = 0.002;

  let current = info.price * (1 + (random() - 0.5) * 0.04);
  const result = [];

  for (let index = 0; index < limit; index += 1) {
    const drift = Math.sin(index / 10) * volatility * 0.15;
    const movement = normalRandom(random) * volatility + drift;
    const open = current;
    const close = Math.max(0.00001, open * (1 + movement));
    const wick = Math.abs(normalRandom(random) * volatility * 0.35);
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick);

    result.push({
      open,
      high,
      low,
      close,
      volume: Math.abs(1000 + normalRandom(random) * 350),
    });

    current = close;
  }

  return result;
}

function formatPrice(value) {
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  return value.toLocaleString("en-US", { maximumFractionDigits: 5 });
}

function getSymbolRows() {
  const hourSeed = Math.floor(Date.now() / 3600000);

  return Object.entries(SYMBOLS).map(([symbol, info], index) => {
    const change24h = Math.sin(index + hourSeed) * 3.2;
    const price = info.price * (1 + Math.sin(Date.now() / 300000 + index) * 0.003);

    return {
      symbol,
      ...info,
      price,
      change24h,
    };
  });
}

function renderSymbols() {
  const rows = getSymbolRows();

  $("symbols").innerHTML = rows.map((item) => `
    <button type="button"
      class="symbol-row ${item.symbol === state.symbol ? "selected" : ""}"
      data-symbol="${item.symbol}">
      <span class="symbol-name">
        <strong>${item.symbol}</strong>
        <span>${item.name}</span>
      </span>
      <strong>${formatPrice(item.price)}</strong>
      <span class="${item.change24h >= 0 ? "up" : "down"}">
        ${item.change24h >= 0 ? "+" : ""}${item.change24h.toFixed(2)}%
      </span>
    </button>
  `).join("");

  document.querySelectorAll(".symbol-row").forEach((button) => {
    button.addEventListener("click", () => {
      state.symbol = button.dataset.symbol;
      state.analysis = null;
      $("analysisResult").classList.add("hidden");
      $("analysisEmpty").classList.remove("hidden");
      renderSymbols();
      updateActiveHeader();
      loadChart();
    });
  });
}

function updateActiveHeader() {
  const row = getSymbolRows().find((item) => item.symbol === state.symbol);
  $("activeSymbol").textContent = row.symbol;
  $("activePrice").textContent = formatPrice(row.price);
  $("activeChange").textContent =
    `${row.change24h >= 0 ? "+" : ""}${row.change24h.toFixed(2)}%`;
  $("activeChange").className = row.change24h >= 0 ? "up" : "down";
  $("summarySymbol").textContent = row.symbol;
  $("summaryTimeframe").textContent = state.interval;
}

function loadChart() {
  state.candles = generateCandles(state.symbol, state.interval);
  drawChart();
  $("chartHint").textContent = `${state.candles.length} свечей · ${state.interval}`;
}

function drawChart() {
  const canvas = $("chart");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));

  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 18, right: 68, bottom: 24, left: 12 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--muted").trim();
  const green = styles.getPropertyValue("--green").trim();
  const red = styles.getPropertyValue("--red").trim();

  const lows = state.candles.map((candle) => candle.low);
  const highs = state.candles.map((candle) => candle.high);

  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const range = Math.max(max - min, max * 0.001);
  min -= range * 0.05;
  max += range * 0.05;

  const y = (price) =>
    padding.top + ((max - price) / (max - min)) * chartHeight;

  context.clearRect(0, 0, width, height);
  context.font = "11px system-ui";

  for (let index = 0; index <= 5; index += 1) {
    const lineY = padding.top + (chartHeight / 5) * index;
    const price = max - ((max - min) / 5) * index;

    context.strokeStyle = "rgba(128, 140, 160, 0.14)";
    context.beginPath();
    context.moveTo(padding.left, lineY);
    context.lineTo(width - padding.right, lineY);
    context.stroke();

    context.fillStyle = muted;
    context.fillText(formatPrice(price), width - padding.right + 8, lineY + 4);
  }

  const step = chartWidth / state.candles.length;
  const bodyWidth = Math.max(2, Math.min(7, step * 0.65));

  state.candles.forEach((candle, index) => {
    const x = padding.left + index * step + step / 2;
    const color = candle.close >= candle.open ? green : red;

    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(x, y(candle.high));
    context.lineTo(x, y(candle.low));
    context.stroke();

    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));

    context.fillStyle = color;
    context.fillRect(
      x - bodyWidth / 2,
      top,
      bodyWidth,
      Math.max(1, bottom - top)
    );
  });
}

function analyzeMarket() {
  const recent = state.candles.slice(-20);
  const broader = state.candles.slice(-60, -20);
  const current = state.candles.at(-1).close;

  const recentHigh = Math.max(...recent.map((item) => item.high));
  const recentLow = Math.min(...recent.map((item) => item.low));
  const broaderHigh = Math.max(...broader.map((item) => item.high));
  const broaderLow = Math.min(...broader.map((item) => item.low));

  const impulse = recent.at(-1).close - recent[0].open;
  const bias = impulse >= 0 ? "LONG" : "SHORT";

  let entry = current;
  let stopLoss;
  let takeProfit;

  if (bias === "LONG") {
    stopLoss = Math.min(recentLow, broaderLow);
    const risk = Math.max(entry - stopLoss, entry * 0.002);
    takeProfit = entry + risk * 2;
  } else {
    stopLoss = Math.max(recentHigh, broaderHigh);
    const risk = Math.max(stopLoss - entry, entry * 0.002);
    takeProfit = entry - risk * 2;
  }

  state.analysis = {
    symbol: state.symbol,
    interval: state.interval,
    bias,
    confidence: 67,
    entry,
    stopLoss,
    takeProfit,
    riskReward: 2,
    demand: [broaderLow, (broaderLow + recentLow) / 2],
    supply: [(broaderHigh + recentHigh) / 2, broaderHigh],
    summary:
      "Демонстрационный алгоритм анализирует последние 60 свечей, направление импульса и более широкий диапазон зон. Перед реальной торговлей стратегию необходимо проверить на истории и подключить настоящий источник котировок.",
  };

  renderAnalysis();
}

function renderAnalysis() {
  const analysis = state.analysis;

  $("analysisEmpty").classList.add("hidden");
  $("analysisResult").classList.remove("hidden");

  $("biasBadge").textContent = analysis.bias;
  $("biasBadge").className =
    `signal-badge ${analysis.bias === "LONG" ? "long" : "short"}`;

  $("confidence").textContent = `Уверенность: ${analysis.confidence}%`;
  $("entry").textContent = formatPrice(analysis.entry);
  $("stopLoss").textContent = formatPrice(analysis.stopLoss);
  $("takeProfit").textContent = formatPrice(analysis.takeProfit);
  $("rr").textContent = `1:${analysis.riskReward}`;
  $("demandZone").textContent =
    `${formatPrice(analysis.demand[0])} — ${formatPrice(analysis.demand[1])}`;
  $("supplyZone").textContent =
    `${formatPrice(analysis.supply[0])} — ${formatPrice(analysis.supply[1])}`;
  $("analysisSummary").textContent = analysis.summary;

  $("calcEntry").value = analysis.entry;
  $("calcStop").value = analysis.stopLoss;
  calculateRisk();
}

function calculateRisk() {
  const balance = Number($("balanceInput").value);
  const riskPercent = Number($("riskInput").value);
  const entry = Number($("calcEntry").value);
  const stop = Number($("calcStop").value);

  const riskMoney = balance * (riskPercent / 100);
  $("calcRiskMoney").textContent = `$${riskMoney.toFixed(2)}`;
  $("riskSummary").textContent = `${riskPercent.toFixed(1)}%`;
  $("riskMoney").textContent = `$${riskMoney.toFixed(2)}`;

  const distance = Math.abs(entry - stop);

  if (entry > 0 && stop > 0 && distance > 0) {
    $("positionSize").textContent = `${(riskMoney / distance).toFixed(4)} ед.`;
  } else {
    $("positionSize").textContent = "—";
  }
}

function getJournal() {
  try {
    return JSON.parse(localStorage.getItem("tradescope-journal") || "[]");
  } catch {
    return [];
  }
}

function saveJournal(items) {
  localStorage.setItem("tradescope-journal", JSON.stringify(items));
}

function savePlan() {
  if (!state.analysis) return;

  const items = getJournal();

  items.unshift({
    id: Date.now(),
    createdAt: new Date().toLocaleString("ru-RU"),
    symbol: state.analysis.symbol,
    interval: state.analysis.interval,
    side: state.analysis.bias,
    entry: state.analysis.entry,
    stopLoss: state.analysis.stopLoss,
    takeProfit: state.analysis.takeProfit,
    riskPercent: Number($("riskInput").value),
  });

  saveJournal(items.slice(0, 100));
  renderJournal();
  showToast("Торговый план сохранён");
}

function renderJournal() {
  const items = getJournal();

  if (!items.length) {
    $("journalList").innerHTML =
      '<div class="empty-state">В журнале пока нет сохранённых планов.</div>';
    return;
  }

  $("journalList").innerHTML = items.map((item) => `
    <article class="journal-item">
      <div>
        <strong>
          ${item.symbol} ·
          <span class="${item.side === "LONG" ? "up" : "down"}">${item.side}</span>
        </strong>
        <div>
          <small>
            ${item.interval} · Вход ${formatPrice(item.entry)}
            · SL ${formatPrice(item.stopLoss)}
            · TP ${formatPrice(item.takeProfit)}
            · риск ${item.riskPercent}%
          </small>
        </div>
      </div>
      <small>${item.createdAt}</small>
    </article>
  `).join("");
}

function clearJournal() {
  if (!getJournal().length) return;
  localStorage.removeItem("tradescope-journal");
  renderJournal();
  showToast("Журнал очищен");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2200);
}

$("intervalSelect").addEventListener("change", (event) => {
  state.interval = event.target.value;
  updateActiveHeader();
  loadChart();
});

$("analyzeButton").addEventListener("click", analyzeMarket);
$("savePlanButton").addEventListener("click", savePlan);
$("clearJournal").addEventListener("click", clearJournal);

["balanceInput", "riskInput", "calcEntry", "calcStop"].forEach((id) => {
  $(id).addEventListener("input", calculateRisk);
});

window.addEventListener("resize", () => {
  clearTimeout(drawChart.resizeTimer);
  drawChart.resizeTimer = setTimeout(drawChart, 100);
});

renderSymbols();
updateActiveHeader();
loadChart();
calculateRisk();
renderJournal();
