const REST_BASE = "https://data-api.binance.vision";
const WS_BASE = "wss://stream.binance.com:9443/ws";

const COINS = [
  { symbol: "BTCUSDT", name: "Bitcoin" },
  { symbol: "ETHUSDT", name: "Ethereum" },
  { symbol: "BNBUSDT", name: "BNB" },
  { symbol: "SOLUSDT", name: "Solana" },
  { symbol: "XRPUSDT", name: "XRP" },
  { symbol: "DOGEUSDT", name: "Dogecoin" },
  { symbol: "ADAUSDT", name: "Cardano" },
  { symbol: "AVAXUSDT", name: "Avalanche" },
  { symbol: "LINKUSDT", name: "Chainlink" },
  { symbol: "SUIUSDT", name: "Sui" },
  { symbol: "TRXUSDT", name: "TRON" },
  { symbol: "LTCUSDT", name: "Litecoin" },
];

const state = {
  symbol: "BTCUSDT",
  interval: "15m",
  candles: [],
  tickers: new Map(),
  socket: null,
  hoveredIndex: null,
  loading: false,
};

const $ = (id) => document.getElementById(id);

function setConnection(status, text) {
  const dot = $("connectionDot");
  dot.className = `connection-dot ${status}`;
  $("connectionText").textContent = text;
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  if (number >= 1000) {
    return number.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (number >= 1) {
    return number.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  return number.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 8,
  });
}

function formatCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Ошибка Binance API: ${response.status}`);
  }
  return response.json();
}

async function loadTickers() {
  const symbolsParam = encodeURIComponent(
    JSON.stringify(COINS.map((coin) => coin.symbol))
  );

  const rows = await fetchJson(
    `${REST_BASE}/api/v3/ticker/24hr?symbols=${symbolsParam}`
  );

  state.tickers.clear();
  rows.forEach((row) => state.tickers.set(row.symbol, row));

  renderSymbols();
  updateSelectedTicker();
}

async function loadCandles() {
  if (state.loading) return;

  state.loading = true;
  $("refreshButton").disabled = true;
  $("chartLoader").classList.remove("hidden");
  $("chartLoader").textContent = "Загрузка реальных свечей…";

  try {
    closeSocket();

    const rows = await fetchJson(
      `${REST_BASE}/api/v3/klines?symbol=${state.symbol}` +
      `&interval=${state.interval}&limit=300`
    );

    state.candles = rows.map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }));

    state.hoveredIndex = null;
    drawChart();
    updateOHLC(state.candles.at(-1));

    $("chartHint").textContent =
      `${state.candles.length} свечей · ${state.interval} · Binance Spot`;

    openSocket();
    setConnection("online", "Реальные данные");
  } catch (error) {
    console.error(error);
    setConnection("offline", "Ошибка подключения");
    $("chartLoader").textContent =
      "Не удалось загрузить данные. Нажмите обновить.";
    showToast(error.message);
  } finally {
    state.loading = false;
    $("refreshButton").disabled = false;

    if (state.candles.length) {
      $("chartLoader").classList.add("hidden");
    }
  }
}

function openSocket() {
  closeSocket();

  const stream =
    `${state.symbol.toLowerCase()}@kline_${state.interval}`;

  state.socket = new WebSocket(`${WS_BASE}/${stream}`);

  state.socket.addEventListener("open", () => {
    setConnection("online", "Реальные данные");
  });

  state.socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    const kline = payload.k;

    const liveCandle = {
      openTime: Number(kline.t),
      open: Number(kline.o),
      high: Number(kline.h),
      low: Number(kline.l),
      close: Number(kline.c),
      volume: Number(kline.v),
      closeTime: Number(kline.T),
    };

    const last = state.candles.at(-1);

    if (last && last.openTime === liveCandle.openTime) {
      state.candles[state.candles.length - 1] = liveCandle;
    } else {
      state.candles.push(liveCandle);
      if (state.candles.length > 300) state.candles.shift();
    }

    const ticker = state.tickers.get(state.symbol);
    if (ticker) ticker.lastPrice = String(liveCandle.close);

    updateSelectedTicker();
    if (state.hoveredIndex === null) updateOHLC(liveCandle);
    drawChart();
  });

  state.socket.addEventListener("close", () => {
    if (state.socket) setConnection("", "Переподключение…");
  });

  state.socket.addEventListener("error", () => {
    setConnection("offline", "WebSocket недоступен");
  });
}

function closeSocket() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }
}

function renderSymbols() {
  const query = $("searchInput").value.trim().toLowerCase();

  const filtered = COINS.filter((coin) =>
    `${coin.symbol} ${coin.name}`.toLowerCase().includes(query)
  );

  $("symbols").innerHTML = filtered.map((coin) => {
    const ticker = state.tickers.get(coin.symbol);
    const price = ticker ? formatPrice(ticker.lastPrice) : "—";
    const change = ticker ? Number(ticker.priceChangePercent) : 0;

    return `
      <button type="button"
        class="symbol-row ${coin.symbol === state.symbol ? "selected" : ""}"
        data-symbol="${coin.symbol}">
        <span class="symbol-name">
          <strong>${coin.symbol.replace("USDT", "")}</strong>
          <span>${coin.name}</span>
        </span>
        <strong>${price}</strong>
        <span class="${change >= 0 ? "up" : "down"}">
          ${ticker ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—"}
        </span>
      </button>
    `;
  }).join("");

  document.querySelectorAll(".symbol-row").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.dataset.symbol === state.symbol) return;

      state.symbol = button.dataset.symbol;
      renderSymbols();
      updateSelectedTicker();
      await loadCandles();
    });
  });
}

function updateSelectedTicker() {
  const coin = COINS.find((item) => item.symbol === state.symbol);
  const ticker = state.tickers.get(state.symbol);

  $("activeSymbol").textContent = state.symbol;
  $("summarySymbol").textContent = state.symbol;
  $("summaryName").textContent = coin?.name || "";
  $("summaryTimeframe").textContent = state.interval;

  if (!ticker) return;

  const price = Number(ticker.lastPrice);
  const change = Number(ticker.priceChangePercent);

  $("activePrice").textContent = formatPrice(price);
  $("summaryPrice").textContent = `${formatPrice(price)} USDT`;

  const changeText = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  $("activeChange").textContent = changeText;
  $("activeChange").className = change >= 0 ? "up" : "down";
  $("summaryChange").textContent = `24ч: ${changeText}`;
  $("summaryChange").className = change >= 0 ? "up" : "down";

  $("dayHigh").textContent = formatPrice(ticker.highPrice);
  $("dayLow").textContent = formatPrice(ticker.lowPrice);
  $("baseVolume").textContent = formatCompact(ticker.volume);
  $("quoteVolume").textContent = `${formatCompact(ticker.quoteVolume)} USDT`;
}

function updateOHLC(candle) {
  if (!candle) return;

  $("ohlcOpen").textContent = formatPrice(candle.open);
  $("ohlcHigh").textContent = formatPrice(candle.high);
  $("ohlcLow").textContent = formatPrice(candle.low);
  $("ohlcClose").textContent = formatPrice(candle.close);
  $("ohlcVolume").textContent = formatCompact(candle.volume);
}

function drawChart() {
  if (!state.candles.length) return;

  const canvas = $("chart");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 18, right: 76, bottom: 30, left: 12 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--muted").trim();
  const green = styles.getPropertyValue("--green").trim();
  const red = styles.getPropertyValue("--red").trim();
  const text = styles.getPropertyValue("--text").trim();

  const lows = state.candles.map((candle) => candle.low);
  const highs = state.candles.map((candle) => candle.high);

  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const rawRange = Math.max(max - min, max * 0.0001);
  min -= rawRange * 0.06;
  max += rawRange * 0.06;

  const y = (price) =>
    padding.top + ((max - price) / (max - min)) * chartHeight;

  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px system-ui";

  for (let index = 0; index <= 5; index += 1) {
    const lineY = padding.top + (chartHeight / 5) * index;
    const price = max - ((max - min) / 5) * index;

    ctx.strokeStyle = "rgba(128, 140, 160, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, lineY);
    ctx.lineTo(width - padding.right, lineY);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.textAlign = "left";
    ctx.fillText(formatPrice(price), width - padding.right + 8, lineY + 4);
  }

  const step = chartWidth / state.candles.length;
  const bodyWidth = Math.max(1.2, Math.min(6, step * 0.68));

  state.candles.forEach((candle, index) => {
    const x = padding.left + index * step + step / 2;
    const color = candle.close >= candle.open ? green : red;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y(candle.high));
    ctx.lineTo(x, y(candle.low));
    ctx.stroke();

    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));

    ctx.fillStyle = color;
    ctx.fillRect(
      x - bodyWidth / 2,
      top,
      bodyWidth,
      Math.max(1, bottom - top)
    );
  });

  const last = state.candles.at(-1);
  const lastY = y(last.close);

  ctx.strokeStyle = last.close >= last.open ? green : red;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padding.left, lastY);
  ctx.lineTo(width - padding.right, lastY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (state.hoveredIndex !== null) {
    const index = Math.max(
      0,
      Math.min(state.candles.length - 1, state.hoveredIndex)
    );
    const x = padding.left + index * step + step / 2;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();

    const candle = state.candles[index];
    updateOHLC(candle);

    const date = new Date(candle.openTime);
    const label = date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    ctx.fillStyle = "rgba(17, 24, 35, 0.96)";
    ctx.fillRect(
      Math.max(padding.left, Math.min(x - 52, width - padding.right - 104)),
      height - padding.bottom + 5,
      104,
      20
    );

    ctx.fillStyle = text;
    ctx.textAlign = "center";
    ctx.fillText(
      label,
      Math.max(padding.left + 52, Math.min(x, width - padding.right - 52)),
      height - padding.bottom + 19
    );
  }
}

function handleChartMove(event) {
  if (!state.candles.length) return;

  const rect = $("chart").getBoundingClientRect();
  const padding = { right: 76, left: 12 };
  const chartWidth = rect.width - padding.left - padding.right;
  const x = event.clientX - rect.left - padding.left;

  if (x < 0 || x > chartWidth) {
    state.hoveredIndex = null;
    updateOHLC(state.candles.at(-1));
  } else {
    state.hoveredIndex = Math.floor(
      (x / chartWidth) * state.candles.length
    );
  }

  drawChart();
}

function calculateRisk() {
  const balance = Number($("balanceInput").value);
  const riskPercent = Number($("riskInput").value);
  const entry = Number($("calcEntry").value);
  const stop = Number($("calcStop").value);

  const riskMoney = balance * (riskPercent / 100);
  $("calcRiskMoney").textContent = `${riskMoney.toFixed(2)} USDT`;

  const distance = Math.abs(entry - stop);

  if (entry > 0 && stop > 0 && distance > 0) {
    $("positionSize").textContent =
      `${(riskMoney / distance).toFixed(6)} ${state.symbol.replace("USDT", "")}`;
  } else {
    $("positionSize").textContent = "—";
  }
}

function getJournal() {
  try {
    return JSON.parse(localStorage.getItem("fastboot-crypto-journal") || "[]");
  } catch {
    return [];
  }
}

function saveJournal(items) {
  localStorage.setItem("fastboot-crypto-journal", JSON.stringify(items));
}

function savePlan() {
  const entry = Number($("calcEntry").value);
  const stop = Number($("calcStop").value);
  const balance = Number($("balanceInput").value);
  const riskPercent = Number($("riskInput").value);

  if (!(entry > 0) || !(stop > 0) || entry === stop) {
    showToast("Укажите корректные цены входа и Stop Loss");
    return;
  }

  const riskMoney = balance * (riskPercent / 100);
  const size = riskMoney / Math.abs(entry - stop);
  const items = getJournal();

  items.unshift({
    id: Date.now(),
    createdAt: new Date().toLocaleString("ru-RU"),
    symbol: state.symbol,
    entry,
    stop,
    riskPercent,
    riskMoney,
    size,
  });

  saveJournal(items.slice(0, 100));
  renderJournal();
  showToast("Расчёт сохранён в журнал");
}

function renderJournal() {
  const items = getJournal();

  if (!items.length) {
    $("journalList").innerHTML =
      '<div class="empty-state">В журнале пока нет сохранённых расчётов.</div>';
    return;
  }

  $("journalList").innerHTML = items.map((item) => `
    <article class="journal-item">
      <div>
        <strong>${item.symbol}</strong>
        <div>
          <small>
            Вход ${formatPrice(item.entry)}
            · SL ${formatPrice(item.stop)}
            · риск ${item.riskPercent}%
            · размер ${Number(item.size).toFixed(6)}
          </small>
        </div>
      </div>
      <small>${item.createdAt}</small>
    </article>
  `).join("");
}

function clearJournal() {
  if (!getJournal().length) return;
  localStorage.removeItem("fastboot-crypto-journal");
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
  }, 2400);
}

$("intervalSelect").addEventListener("change", async (event) => {
  state.interval = event.target.value;
  $("summaryTimeframe").textContent = state.interval;
  await loadCandles();
});

$("refreshButton").addEventListener("click", async () => {
  await Promise.all([loadTickers(), loadCandles()]);
  showToast("Данные обновлены");
});

$("searchInput").addEventListener("input", renderSymbols);
$("savePlanButton").addEventListener("click", savePlan);
$("clearJournal").addEventListener("click", clearJournal);

["balanceInput", "riskInput", "calcEntry", "calcStop"].forEach((id) => {
  $(id).addEventListener("input", calculateRisk);
});

$("chart").addEventListener("mousemove", handleChartMove);
$("chart").addEventListener("mouseleave", () => {
  state.hoveredIndex = null;
  updateOHLC(state.candles.at(-1));
  drawChart();
});

window.addEventListener("resize", () => {
  clearTimeout(drawChart.resizeTimer);
  drawChart.resizeTimer = setTimeout(drawChart, 100);
});

window.addEventListener("beforeunload", closeSocket);

async function start() {
  calculateRisk();
  renderJournal();

  try {
    await loadTickers();
    await loadCandles();

    setInterval(() => {
      loadTickers().catch(console.error);
    }, 30000);
  } catch (error) {
    console.error(error);
    setConnection("offline", "Ошибка подключения");
    showToast(
      "Не удалось подключиться к Binance. Проверьте интернет или доступность сервиса."
    );
  }
}

start();
