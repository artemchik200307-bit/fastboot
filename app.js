const REST_BASE = "https://data-api.binance.vision";
const WS_BASE = "wss://stream.binance.com:9443/ws";

const EXCLUDED_BASE_ASSETS = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "AEUR", "TRY", "BRL",
]);

const EXCLUDED_SUFFIXES = ["UP", "DOWN", "BULL", "BEAR"];

const COIN_NAMES = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BNB: "BNB",
  SOL: "Solana",
  XRP: "XRP",
  DOGE: "Dogecoin",
  ADA: "Cardano",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  SUI: "Sui",
  TRX: "TRON",
  LTC: "Litecoin",
  TON: "Toncoin",
  DOT: "Polkadot",
  BCH: "Bitcoin Cash",
  SHIB: "Shiba Inu",
  XLM: "Stellar",
  HBAR: "Hedera",
  UNI: "Uniswap",
  AAVE: "Aave",
  NEAR: "NEAR Protocol",
  APT: "Aptos",
  FIL: "Filecoin",
  ICP: "Internet Computer",
  ATOM: "Cosmos",
  ARB: "Arbitrum",
  OP: "Optimism",
  ETC: "Ethereum Classic",
  ALGO: "Algorand",
  VET: "VeChain",
  INJ: "Injective",
  RENDER: "Render",
  FET: "Artificial Superintelligence",
  PEPE: "Pepe",
  WIF: "dogwifhat",
  BONK: "Bonk",
};

const state = {
  symbol: "BTCUSDT",
  interval: "15m",
  instruments: [],
  tickers: new Map(),
  candles: [],
  socket: null,
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  chartHeight: Number(localStorage.getItem("fastboot-chart-height")) || 470,
  loading: false,
};

const $ = (id) => document.getElementById(id);

function setConnection(status, text) {
  $("connectionDot").className = `connection-dot ${status}`;
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
    throw new Error(`Ошибка рыночного API: ${response.status}`);
  }

  return response.json();
}

function isAllowedInstrument(symbolInfo) {
  const base = symbolInfo.baseAsset;

  return (
    symbolInfo.status === "TRADING" &&
    symbolInfo.quoteAsset === "USDT" &&
    symbolInfo.isSpotTradingAllowed !== false &&
    !EXCLUDED_BASE_ASSETS.has(base) &&
    !EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

async function loadMarketUniverse() {
  const [exchangeInfo, allTickers] = await Promise.all([
    fetchJson(`${REST_BASE}/api/v3/exchangeInfo`),
    fetchJson(`${REST_BASE}/api/v3/ticker/24hr`),
  ]);

  const allowed = new Map(
    exchangeInfo.symbols
      .filter(isAllowedInstrument)
      .map((item) => [item.symbol, item])
  );

  const ranked = allTickers
    .filter((ticker) => allowed.has(ticker.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 100)
    .map((ticker) => {
      const info = allowed.get(ticker.symbol);

      return {
        symbol: ticker.symbol,
        baseAsset: info.baseAsset,
        name: COIN_NAMES[info.baseAsset] || info.baseAsset,
        ticker,
      };
    });

  state.instruments = ranked;
  state.tickers.clear();

  ranked.forEach((item) => {
    state.tickers.set(item.symbol, item.ticker);
  });

  if (!state.tickers.has(state.symbol) && ranked.length) {
    state.symbol = ranked[0].symbol;
  }

  renderSymbols();
  renderTickerBar();
  updateSelectedTicker();
}

async function refreshTickers() {
  const rows = await fetchJson(`${REST_BASE}/api/v3/ticker/24hr`);
  const rowMap = new Map(rows.map((row) => [row.symbol, row]));

  state.instruments.forEach((item) => {
    const latest = rowMap.get(item.symbol);

    if (latest) {
      item.ticker = latest;
      state.tickers.set(item.symbol, latest);
    }
  });

  state.instruments.sort(
    (a, b) => Number(b.ticker.quoteVolume) - Number(a.ticker.quoteVolume)
  );

  renderSymbols();
  renderTickerBar();
  updateSelectedTicker();
}

function renderTickerBar() {
  const items = state.instruments.slice(0, 24);

  if (!items.length) return;

  const group = items.map((item) => {
    const price = formatPrice(item.ticker.lastPrice);
    const change = Number(item.ticker.priceChangePercent);

    return `
      <span class="ticker-item">
        <span class="ticker-symbol">${item.baseAsset}/USDT</span>
        <span class="ticker-price">${price}</span>
        <span class="${change >= 0 ? "up" : "down"}">
          ${change >= 0 ? "+" : ""}${change.toFixed(2)}%
        </span>
      </span>
    `;
  }).join("");

  $("tickerTrack").innerHTML = `
    <div class="ticker-group">${group}</div>
    <div class="ticker-group" aria-hidden="true">${group}</div>
  `;
}

function renderSymbols() {
  const query = $("searchInput").value.trim().toLowerCase();

  const filtered = state.instruments.filter((item) => {
    return `${item.symbol} ${item.baseAsset} ${item.name}`
      .toLowerCase()
      .includes(query);
  });

  if (!filtered.length) {
    $("symbols").innerHTML =
      '<div class="empty-list">Инструменты не найдены.</div>';
    return;
  }

  $("symbols").innerHTML = filtered.map((item) => {
    const change = Number(item.ticker.priceChangePercent);

    return `
      <button type="button"
        class="symbol-row ${item.symbol === state.symbol ? "selected" : ""}"
        data-symbol="${item.symbol}">
        <span class="symbol-name">
          <strong>${item.baseAsset}/USDT</strong>
          <span>${item.name}</span>
        </span>

        <strong>${formatPrice(item.ticker.lastPrice)}</strong>

        <span class="${change >= 0 ? "up" : "down"}">
          ${change >= 0 ? "+" : ""}${change.toFixed(2)}%
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

function selectedInstrument() {
  return state.instruments.find((item) => item.symbol === state.symbol);
}

function updateSelectedTicker() {
  const instrument = selectedInstrument();
  const ticker = state.tickers.get(state.symbol);

  if (!instrument || !ticker) return;

  const price = Number(ticker.lastPrice);
  const change = Number(ticker.priceChangePercent);
  const changeText = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

  $("activeSymbol").textContent = `${instrument.baseAsset}/USDT`;
  $("summarySymbol").textContent = `${instrument.baseAsset}/USDT`;
  $("summaryName").textContent = instrument.name;
  $("summaryTimeframe").textContent = state.interval;

  $("activePrice").textContent = formatPrice(price);
  $("summaryPrice").textContent = `${formatPrice(price)} USDT`;

  $("activeChange").textContent = changeText;
  $("activeChange").className = change >= 0 ? "up" : "down";

  $("summaryChange").textContent = `24ч: ${changeText}`;
  $("summaryChange").className = change >= 0 ? "up" : "down";

  $("dayHigh").textContent = formatPrice(ticker.highPrice);
  $("dayLow").textContent = formatPrice(ticker.lowPrice);
  $("baseVolume").textContent =
    `${formatCompact(ticker.volume)} ${instrument.baseAsset}`;
  $("quoteVolume").textContent =
    `${formatCompact(ticker.quoteVolume)} USDT`;
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
      `&interval=${state.interval}&limit=500`
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

    setChartData({ fit: true });
    updateOHLC(state.candles.at(-1));

    $("chartHint").textContent =
      `${state.candles.length} свечей · ${state.interval} · Binance Spot`;

    openSocket();
    setConnection("online", "Реальные данные");
    $("chartLoader").classList.add("hidden");
  } catch (error) {
    console.error(error);
    setConnection("offline", "Ошибка подключения");
    $("chartLoader").textContent =
      "Не удалось загрузить свечи. Нажмите обновить.";
    showToast(error.message);
  } finally {
    state.loading = false;
    $("refreshButton").disabled = false;
  }
}

function openSocket() {
  closeSocket();

  const stream = `${state.symbol.toLowerCase()}@kline_${state.interval}`;
  state.socket = new WebSocket(`${WS_BASE}/${stream}`);

  state.socket.addEventListener("open", () => {
    setConnection("online", "Реальные данные");
  });

  state.socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    const kline = payload.k;

    const candle = {
      openTime: Number(kline.t),
      open: Number(kline.o),
      high: Number(kline.h),
      low: Number(kline.l),
      close: Number(kline.c),
      volume: Number(kline.v),
      closeTime: Number(kline.T),
    };

    const last = state.candles.at(-1);

    if (last && last.openTime === candle.openTime) {
      state.candles[state.candles.length - 1] = candle;
    } else {
      state.candles.push(candle);

      if (state.candles.length > 500) {
        state.candles.shift();
      }
    }

    const ticker = state.tickers.get(state.symbol);

    if (ticker) {
      ticker.lastPrice = String(candle.close);
    }

    updateSelectedTicker();
    updateOHLC(candle);
    updateLiveChart(candle);
  });

  state.socket.addEventListener("error", () => {
    setConnection("offline", "WebSocket недоступен");
  });
}

function closeSocket() {
  if (!state.socket) return;

  state.socket.onclose = null;
  state.socket.close();
  state.socket = null;
}

function updateOHLC(candle) {
  if (!candle) return;

  $("ohlcOpen").textContent = formatPrice(candle.open);
  $("ohlcHigh").textContent = formatPrice(candle.high);
  $("ohlcLow").textContent = formatPrice(candle.low);
  $("ohlcClose").textContent = formatPrice(candle.close);
  $("ohlcVolume").textContent = formatCompact(candle.volume);
}

function chartCandle(candle) {
  return {
    time: Math.floor(candle.openTime / 1000),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function chartVolume(candle) {
  return {
    time: Math.floor(candle.openTime / 1000),
    value: candle.volume,
    color: candle.close >= candle.open
      ? "rgba(32, 201, 135, 0.35)"
      : "rgba(255, 95, 120, 0.35)",
  };
}

function createInteractiveChart() {
  if (!window.LightweightCharts) {
    throw new Error("Библиотека графика не загрузилась");
  }

  const container = $("chart");
  container.style.height = `${state.chartHeight}px`;

  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--bg").trim();
  const muted = styles.getPropertyValue("--muted").trim();
  const green = styles.getPropertyValue("--green").trim();
  const red = styles.getPropertyValue("--red").trim();

  state.chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: state.chartHeight,

    layout: {
      background: { type: "solid", color: bg },
      textColor: muted,
      attributionLogo: false,
    },

    grid: {
      vertLines: { color: "rgba(128, 140, 160, 0.10)" },
      horzLines: { color: "rgba(128, 140, 160, 0.10)" },
    },

    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },

    rightPriceScale: {
      borderColor: "rgba(255, 255, 255, 0.08)",
      scaleMargins: {
        top: 0.08,
        bottom: 0.24,
      },
    },

    timeScale: {
      borderColor: "rgba(255, 255, 255, 0.08)",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      minBarSpacing: 1.5,
    },

    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true,
    },

    handleScale: {
      axisPressedMouseMove: {
        time: true,
        price: true,
      },
      mouseWheel: true,
      pinch: true,
    },
  });

  state.candleSeries = state.chart.addSeries(
    LightweightCharts.CandlestickSeries,
    {
      upColor: green,
      downColor: red,
      borderVisible: false,
      wickUpColor: green,
      wickDownColor: red,
      priceLineVisible: true,
      lastValueVisible: true,
    }
  );

  state.volumeSeries = state.chart.addSeries(
    LightweightCharts.HistogramSeries,
    {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    }
  );

  state.volumeSeries.priceScale().applyOptions({
    scaleMargins: {
      top: 0.80,
      bottom: 0,
    },
  });

  state.chart.subscribeCrosshairMove((param) => {
    if (!param?.time || !param.seriesData) {
      updateOHLC(state.candles.at(-1));
      return;
    }

    const candle = param.seriesData.get(state.candleSeries);
    const volume = param.seriesData.get(state.volumeSeries);

    if (candle) {
      updateOHLC({
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: volume?.value || 0,
      });
    }
  });

  new ResizeObserver(resizeInteractiveChart).observe(container);
}

function setChartData({ fit = false } = {}) {
  if (!state.chart) {
    createInteractiveChart();
  }

  state.candleSeries.setData(state.candles.map(chartCandle));
  state.volumeSeries.setData(state.candles.map(chartVolume));

  if (fit) {
    state.chart.timeScale().fitContent();
  }
}

function updateLiveChart(candle) {
  if (!state.candleSeries || !state.volumeSeries) return;

  state.candleSeries.update(chartCandle(candle));
  state.volumeSeries.update(chartVolume(candle));
}

function resizeInteractiveChart() {
  if (!state.chart) return;

  const container = $("chart");
  const panel = $("chartPanel");

  const height = panel.classList.contains("fullscreen")
    ? Math.max(300, panel.clientHeight - 56)
    : state.chartHeight;

  container.style.height = `${height}px`;
  state.chart.resize(container.clientWidth, height);
}

function setupChartResize() {
  const handle = $("chartResizeHandle");
  let startY = 0;
  let startHeight = 0;

  const move = (event) => {
    const nextHeight = Math.max(
      280,
      Math.min(900, startHeight + event.clientY - startY)
    );

    state.chartHeight = nextHeight;
    localStorage.setItem("fastboot-chart-height", String(nextHeight));
    resizeInteractiveChart();
  };

  const stop = () => {
    document.body.classList.remove("chart-resizing");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };

  handle.addEventListener("pointerdown", (event) => {
    if ($("chartPanel").classList.contains("fullscreen")) return;

    startY = event.clientY;
    startHeight = state.chartHeight;

    document.body.classList.add("chart-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });
}

function toggleChartFullscreen() {
  const panel = $("chartPanel");
  const enabled = panel.classList.toggle("fullscreen");

  $("fullscreenButton").textContent = enabled ? "✕" : "⤢";
  document.body.style.overflow = enabled ? "hidden" : "";

  requestAnimationFrame(resizeInteractiveChart);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(showToast.timer);

  showToast.timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2300);
}

$("intervalSelect").addEventListener("change", async (event) => {
  state.interval = event.target.value;
  $("summaryTimeframe").textContent = state.interval;
  await loadCandles();
});

$("searchInput").addEventListener("input", renderSymbols);

$("refreshButton").addEventListener("click", async () => {
  try {
    await Promise.all([refreshTickers(), loadCandles()]);
    showToast("Данные обновлены");
  } catch (error) {
    showToast(error.message);
  }
});

$("resetChartButton").addEventListener("click", () => {
  state.chart?.timeScale().fitContent();
});

$("fullscreenButton").addEventListener("click", toggleChartFullscreen);

$("loginButton").addEventListener("click", () => {
  showToast("Вход будет добавлен следующим этапом");
});

$("registerButton").addEventListener("click", () => {
  showToast("Регистрация будет добавлена следующим этапом");
});

window.addEventListener("resize", resizeInteractiveChart);
window.addEventListener("beforeunload", closeSocket);

async function start() {
  setupChartResize();

  try {
    await loadMarketUniverse();
    await loadCandles();

    setInterval(() => {
      refreshTickers().catch(console.error);
    }, 60000);
  } catch (error) {
    console.error(error);
    setConnection("offline", "Ошибка подключения");
    showToast(
      "Не удалось подключиться к рыночным данным. Проверьте интернет."
    );
  }
}

start();
