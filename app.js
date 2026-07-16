const REST_BASE = "https://data-api.binance.vision";

const EXCLUDED_BASE_ASSETS = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "AEUR", "TRY", "BRL",
]);

const EXCLUDED_SUFFIXES = ["UP", "DOWN", "BULL", "BEAR"];

const COIN_NAMES = {
  BTC: "Bitcoin", ETH: "Ethereum", BNB: "BNB", SOL: "Solana",
  XRP: "XRP", DOGE: "Dogecoin", ADA: "Cardano", AVAX: "Avalanche",
  LINK: "Chainlink", SUI: "Sui", TRX: "TRON", LTC: "Litecoin",
  TON: "Toncoin", DOT: "Polkadot", BCH: "Bitcoin Cash",
  SHIB: "Shiba Inu", XLM: "Stellar", HBAR: "Hedera",
  UNI: "Uniswap", AAVE: "Aave", NEAR: "NEAR Protocol",
  APT: "Aptos", FIL: "Filecoin", ICP: "Internet Computer",
  ATOM: "Cosmos", ARB: "Arbitrum", OP: "Optimism",
  ETC: "Ethereum Classic", ALGO: "Algorand", VET: "VeChain",
  INJ: "Injective", RENDER: "Render", FET: "Artificial Superintelligence",
  PEPE: "Pepe", WIF: "dogwifhat", BONK: "Bonk",
};

const state = {
  symbol: "BTCUSDT",
  instruments: [],
  lastUpdatedAt: null,
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

function isAllowedInstrument(info) {
  const base = info.baseAsset;

  return (
    info.status === "TRADING" &&
    info.quoteAsset === "USDT" &&
    info.isSpotTradingAllowed !== false &&
    !EXCLUDED_BASE_ASSETS.has(base) &&
    !EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

async function loadMarketData() {
  setConnection("", "Обновление данных…");

  const [exchangeInfo, tickers] = await Promise.all([
    fetchJson(`${REST_BASE}/api/v3/exchangeInfo`),
    fetchJson(`${REST_BASE}/api/v3/ticker/24hr`),
  ]);

  const allowed = new Map(
    exchangeInfo.symbols
      .filter(isAllowedInstrument)
      .map((info) => [info.symbol, info])
  );

  state.instruments = tickers
    .filter((ticker) => allowed.has(ticker.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 100)
    .map((ticker, index) => {
      const info = allowed.get(ticker.symbol);

      return {
        rank: index + 1,
        symbol: ticker.symbol,
        baseAsset: info.baseAsset,
        name: COIN_NAMES[info.baseAsset] || info.baseAsset,
        ticker,
      };
    });

  if (!state.instruments.some((item) => item.symbol === state.symbol)) {
    state.symbol = state.instruments[0]?.symbol || "";
  }

  state.lastUpdatedAt = new Date();

  renderTickerBar();
  renderMarketList();
  renderMovers();
  updateSelectedMarket();
  updateLastUpdated();
  setConnection("online", "Реальные данные");
}

function updateLastUpdated() {
  if (!state.lastUpdatedAt) return;

  $("lastUpdate").textContent = `Обновлено: ${state.lastUpdatedAt.toLocaleTimeString(
    "ru-RU",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" }
  )}`;
}

function renderTickerBar() {
  const items = state.instruments.slice(0, 24);

  const group = items.map((item) => {
    const change = Number(item.ticker.priceChangePercent);

    return `
      <span class="ticker-item">
        <span class="ticker-symbol">${item.baseAsset}/USDT</span>
        <span>${formatPrice(item.ticker.lastPrice)}</span>
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

function renderMovers() {
  const byChange = [...state.instruments].sort(
    (a, b) =>
      Number(b.ticker.priceChangePercent) -
      Number(a.ticker.priceChangePercent)
  );

  renderMoverList("topGainers", byChange.slice(0, 5));
  renderMoverList("topLosers", byChange.slice(-5).reverse());
}

function renderMoverList(containerId, items) {
  $(containerId).innerHTML = items.map((item) => {
    const change = Number(item.ticker.priceChangePercent);

    return `
      <button type="button"
        class="mover-item ${item.symbol === state.symbol ? "selected" : ""}"
        data-symbol="${item.symbol}">
        <strong>${item.baseAsset}/USDT</strong>
        <span class="mover-price">${formatPrice(item.ticker.lastPrice)}</span>
        <span class="${change >= 0 ? "up" : "down"}">
          ${change >= 0 ? "+" : ""}${change.toFixed(2)}%
        </span>
      </button>
    `;
  }).join("");

  document.querySelectorAll(`#${containerId} .mover-item`).forEach((button) => {
    button.addEventListener("click", () => selectInstrument(button.dataset.symbol));
  });
}

function renderMarketList() {
  const query = $("searchInput").value.trim().toLowerCase();

  const filtered = state.instruments.filter((item) =>
    `${item.symbol} ${item.baseAsset} ${item.name}`
      .toLowerCase()
      .includes(query)
  );

  if (!filtered.length) {
    $("symbols").innerHTML =
      '<div class="empty-list">Инструменты не найдены.</div>';
    return;
  }

  $("symbols").innerHTML = filtered.map((item) => {
    const ticker = item.ticker;
    const change = Number(ticker.priceChangePercent);

    return `
      <button type="button"
        class="market-row ${item.symbol === state.symbol ? "selected" : ""}"
        data-symbol="${item.symbol}">
        <span class="market-rank">${item.rank}</span>

        <span class="market-name">
          <strong>${item.baseAsset}/USDT</strong>
          <span>${item.name}</span>
        </span>

        <strong class="market-value">${formatPrice(ticker.lastPrice)}</strong>

        <span class="market-value ${change >= 0 ? "up" : "down"}">
          ${change >= 0 ? "+" : ""}${change.toFixed(2)}%
        </span>

        <span class="market-value mobile-hidden">
          ${formatPrice(ticker.highPrice)}
        </span>

        <span class="market-value mobile-hidden">
          ${formatPrice(ticker.lowPrice)}
        </span>

        <span class="market-value mobile-hidden">
          ${formatCompact(ticker.quoteVolume)}
        </span>
      </button>
    `;
  }).join("");

  document.querySelectorAll(".market-row").forEach((button) => {
    button.addEventListener("click", () => selectInstrument(button.dataset.symbol));
  });
}

function selectInstrument(symbol) {
  state.symbol = symbol;
  renderMarketList();
  renderMovers();
  updateSelectedMarket();

  if (window.innerWidth <= 1050) {
    document.querySelector(".selected-market-panel")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function updateSelectedMarket() {
  const item = state.instruments.find(
    (instrument) => instrument.symbol === state.symbol
  );

  if (!item) return;

  const ticker = item.ticker;
  const changePercent = Number(ticker.priceChangePercent);
  const priceChangeValue = Number(ticker.priceChange);
  const changeText =
    `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`;

  $("selectedSymbol").textContent = `${item.baseAsset}/USDT`;
  $("selectedName").textContent = item.name;
  $("selectedPrice").textContent = formatPrice(ticker.lastPrice);
  $("selectedChange").textContent = changeText;
  $("selectedChange").className = changePercent >= 0 ? "up" : "down";

  $("dayHigh").textContent = formatPrice(ticker.highPrice);
  $("dayLow").textContent = formatPrice(ticker.lowPrice);
  $("priceChange").textContent =
    `${priceChangeValue >= 0 ? "+" : ""}${formatPrice(priceChangeValue)}`;
  $("priceChange").className = priceChangeValue >= 0 ? "up" : "down";
  $("weightedAverage").textContent = formatPrice(ticker.weightedAvgPrice);
  $("baseVolume").textContent =
    `${formatCompact(ticker.volume)} ${item.baseAsset}`;
  $("quoteVolume").textContent =
    `${formatCompact(ticker.quoteVolume)} USDT`;
  $("tradeCount").textContent = Number(ticker.count).toLocaleString("en-US");
  $("openPrice").textContent = formatPrice(ticker.openPrice);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 2300);
}

$("searchInput").addEventListener("input", renderMarketList);

$("registerButton").addEventListener("click", () => {
  showToast("Регистрация будет добавлена следующим этапом");
});

async function start() {
  try {
    await loadMarketData();

    setInterval(() => {
      loadMarketData().catch((error) => {
        console.error(error);
        setConnection("offline", "Ошибка обновления");
      });
    }, 60000);
  } catch (error) {
    console.error(error);
    setConnection("offline", "Ошибка подключения");
    showToast("Не удалось загрузить рыночные данные.");
  }
}

start();


document.getElementById("learnMoreButton")?.addEventListener("click", () => {
  showToast("Модули FASTBOOT AI находятся в разработке");
});
