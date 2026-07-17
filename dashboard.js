const REST_BASE = "https://data-api.binance.vision";
const WS_BASE = "wss://stream.binance.com:9443/ws";
const $ = (id) => document.getElementById(id);

const session = (() => {
  try { return JSON.parse(localStorage.getItem("fastboot-session") || "null"); }
  catch { return null; }
})();

if (!session) window.location.href = "login.html";

const state = {
  section: "overview",
  portfolio: JSON.parse(localStorage.getItem("fastboot-portfolio") || '[{"asset":"USDT","name":"Tether","amount":0},{"asset":"BTC","name":"Bitcoin","amount":0},{"asset":"ETH","name":"Ethereum","amount":0},{"asset":"SOL","name":"Solana","amount":0}]'),
  deposits: JSON.parse(localStorage.getItem("fastboot-deposits") || "[]"),
  withdrawals: JSON.parse(localStorage.getItem("fastboot-withdrawals") || "[]"),
  botBalance: Number(localStorage.getItem("fastboot-bot-balance") || 0),
  botRunning: localStorage.getItem("fastboot-bot-running") === "true",
  orders: JSON.parse(localStorage.getItem("fastboot-orders") || "[]"),
  prices: {},
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  tradeSocket: null,
  currentSymbol: "BTCUSDT",
  orderSide: "BUY",
  marketUniverse: [],
};

const titles = {
  overview: "Dashboard",
  assistant: "AI Assistant",
  trading: "Торговля",
  "market-analysis": "Анализ рынка",
  journal: "Торговый журнал",
  settings: "Настройки",
};

function saveState() {
  localStorage.setItem("fastboot-portfolio", JSON.stringify(state.portfolio));
  localStorage.setItem("fastboot-deposits", JSON.stringify(state.deposits));
  localStorage.setItem("fastboot-withdrawals", JSON.stringify(state.withdrawals));
  localStorage.setItem("fastboot-bot-balance", String(state.botBalance));
  localStorage.setItem("fastboot-bot-running", String(state.botRunning));
  localStorage.setItem("fastboot-orders", JSON.stringify(state.orders));
}

function showToast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $("toast").classList.add("hidden"), 2300);
}

function openSection(id) {
  state.section = id;
  document.body.classList.toggle("trading-mode", id === "trading");
  document.querySelectorAll(".dashboard-section").forEach((el) => el.classList.toggle("active", el.id === id));
  document.querySelectorAll(".nav-item[data-section]").forEach((el) => el.classList.toggle("active", el.dataset.section === id));
  $("pageTitle").textContent = titles[id] || "FASTBOOT";
  $("sidebar").classList.remove("open");
  document.body.classList.toggle("trading-mode", id === "trading");
  if (id === "trading") loadTradingTerminal();
  if (id === "market-analysis") loadMarketAnalysis();
  if (id === "journal") renderJournal();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-section]").forEach((btn) => btn.addEventListener("click", () => openSection(btn.dataset.section)));
$("menuButton").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("logoutButton").addEventListener("click", () => { localStorage.removeItem("fastboot-session"); window.location.href = "login.html"; });

function initializeUser() {
  $("profileName").textContent = session.name;
  $("profileId").textContent = `ID: ${session.id}`;
  $("profileAvatar").textContent = session.name.charAt(0).toUpperCase();
  $("accountOwner").textContent = session.name;
  $("accountEmail").textContent = `${session.email}${session.role === "admin" ? " · Administrator" : ""}`;
  $("accountId").textContent = session.id;
  $("settingsName").value = session.name;
  $("settingsEmail").value = session.email;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}

async function loadPrices() {
  try {
    const rows = await fetchJson(`${REST_BASE}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(["BTCUSDT","ETHUSDT","SOLUSDT"]))}`);
    rows.forEach((row) => state.prices[row.symbol.replace("USDT","")] = Number(row.price));
    state.prices.USDT = 1;
    renderAccount();
  } catch {
    state.prices = { USDT: 1, BTC: 0, ETH: 0, SOL: 0 };
    renderAccount();
  }
}

function portfolioValue(item) {
  return item.amount * (state.prices[item.asset] || 0);
}

function renderAccount() {
  const total = state.portfolio.reduce((sum, item) => sum + portfolioValue(item), 0);
  $("totalBalance").textContent = `$${total.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

  $("portfolioList").innerHTML = state.portfolio.map((item) => `
    <div class="portfolio-row">
      <span class="asset-name"><strong>${item.asset}</strong><span>${item.name}</span></span>
      <strong>${item.amount.toFixed(item.asset === "USDT" ? 2 : 8)}</strong>
      <span>${item.asset === "USDT" ? "1.00" : formatPrice(state.prices[item.asset])}</span>
      <span>$${portfolioValue(item).toFixed(2)}</span>
    </div>`).join("");

  $("allocationBars").innerHTML = state.portfolio.map((item) => {
    const value = portfolioValue(item);
    const percent = total > 0 ? value / total * 100 : 0;
    return `<div class="allocation-item"><div><span>${item.asset}</span><strong>${percent.toFixed(1)}%</strong></div><div class="allocation-track"><div class="allocation-fill" style="width:${percent}%"></div></div></div>`;
  }).join("");

  renderOperations();
  renderBot();
}

function renderOperations() {
  const operationHtml = (items) => items.length ? items.slice(0,8).map((item) => `
    <div class="operation-row"><div><strong>${item.asset}</strong><br><span>${item.date}</span></div><strong>${item.amount.toFixed(2)}</strong></div>`).join("") : '<div class="empty-list">Операций пока нет</div>';
  $("depositHistory").innerHTML = operationHtml(state.deposits);
  $("withdrawHistory").innerHTML = operationHtml(state.withdrawals);
}

function openMoneyModal(type) {
  const config = {
    deposit: ["Пополнение счёта", "Пополнить"],
    withdraw: ["Вывод средств", "Вывести"],
    exchange: ["Обмен активов", "Обменять"],
  }[type];

  $("modalTitle").textContent = config[0];
  $("modalBody").innerHTML = type === "exchange" ? `
    <div class="modal-form">
      <label>Из актива<select id="modalFromAsset">${state.portfolio.map(x=>`<option>${x.asset}</option>`).join("")}</select></label>
      <label>В актив<select id="modalToAsset">${state.portfolio.map(x=>`<option>${x.asset}</option>`).join("")}</select></label>
      <label>Количество<input id="modalAmount" type="number" step="any" min="0"></label>
      <button id="confirmModalAction" class="primary-action" type="button">${config[1]}</button>
    </div>` : `
    <div class="modal-form">
      <label>Актив<select id="modalAsset">${state.portfolio.map(x=>`<option>${x.asset}</option>`).join("")}</select></label>
      <label>Количество<input id="modalAmount" type="number" step="any" min="0"></label>
      <button id="confirmModalAction" class="primary-action" type="button">${config[1]}</button>
    </div>`;

  $("actionModal").classList.remove("hidden");
  $("confirmModalAction").addEventListener("click", () => processMoneyAction(type));
}

function processMoneyAction(type) {
  const amount = Number($("modalAmount").value);
  if (!(amount > 0)) return showToast("Введите корректную сумму");

  if (type === "exchange") {
    const from = $("modalFromAsset").value;
    const to = $("modalToAsset").value;
    if (from === to) return showToast("Выберите разные активы");
    const fromItem = state.portfolio.find(x=>x.asset===from);
    const toItem = state.portfolio.find(x=>x.asset===to);
    if (fromItem.amount < amount) return showToast("Недостаточно средств");
    const usdValue = amount * (state.prices[from] || 0);
    const received = usdValue / (state.prices[to] || 1);
    fromItem.amount -= amount;
    toItem.amount += received;
  } else {
    const asset = $("modalAsset").value;
    const item = state.portfolio.find(x=>x.asset===asset);
    if (type === "withdraw" && item.amount < amount) return showToast("Недостаточно средств");
    item.amount += type === "deposit" ? amount : -amount;
    const record = { asset, amount, date: new Date().toLocaleString("ru-RU") };
    (type === "deposit" ? state.deposits : state.withdrawals).unshift(record);
  }

  saveState(); renderAccount(); $("actionModal").classList.add("hidden"); showToast("Операция сохранена");
}

$("depositButton").addEventListener("click",()=>openMoneyModal("deposit"));
$("withdrawButton").addEventListener("click",()=>openMoneyModal("withdraw"));
$("exchangeButton").addEventListener("click",()=>openMoneyModal("exchange"));
$("closeModalButton").addEventListener("click",()=>$("actionModal").classList.add("hidden"));

function renderBot() {
  $("botBalance").textContent = `$${state.botBalance.toFixed(2)}`;
  $("botStatus").textContent = state.botRunning ? "Активен" : "Остановлен";
  $("botStatus").className = state.botRunning ? "positive" : "";
  $("botStatusDescription").textContent = state.botRunning ? "Алгоритм выполняет мониторинг рынка" : "Торговля не запущена";
  $("toggleBotButton").textContent = state.botRunning ? "Остановить торговлю" : "Запустить торговлю";
}

$("transferToBotButton").addEventListener("click",()=>{
  const amount = Number($("botTransferAmount").value);
  const usdt = state.portfolio.find(x=>x.asset==="USDT");
  if (!(amount>0)) return showToast("Введите сумму");
  if (usdt.amount < amount) return showToast("Недостаточно USDT на основном счёте");
  usdt.amount -= amount; state.botBalance += amount; $("botTransferAmount").value = "";
  saveState(); renderAccount(); showToast("Средства переведены на счёт бота");
});
$("toggleBotButton").addEventListener("click",()=>{
  if (state.botBalance <= 0 && !state.botRunning) return showToast("Сначала переведите средства на счёт бота");
  state.botRunning = !state.botRunning; saveState(); renderBot(); showToast(state.botRunning ? "Торговля бота запущена" : "Торговля бота остановлена");
});
const periodStats = {
  day:[0,0,0,0], week:[0,0,0,0], month:[0,0,0,0], quarter:[0,0,0,0]
};
$("botPeriodTabs").querySelectorAll("button").forEach(btn=>btn.addEventListener("click",()=>{
  $("botPeriodTabs").querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===btn));
  const [ret,trades,wr,dd]=periodStats[btn.dataset.period];
  $("periodReturn").textContent=`${ret.toFixed(2)}%`; $("periodTrades").textContent=trades;
  $("periodWinRate").textContent=`${wr}%`; $("periodDrawdown").textContent=`${dd.toFixed(2)}%`;
}));

function formatPrice(value) {
  const n = Number(value); if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? n.toLocaleString("en-US",{maximumFractionDigits:2,minimumFractionDigits:2}) :
    n >= 1 ? n.toFixed(4) : n.toFixed(8);
}


const COIN_DISPLAY_NAMES = {
  BTCUSDT: "Bitcoin / Tether",
  ETHUSDT: "Ethereum / Tether",
  SOLUSDT: "Solana / Tether",
  BNBUSDT: "BNB / Tether",
  XRPUSDT: "XRP / Tether",
};


const EXCLUDED_MARKET_ASSETS = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "AEUR", "TRY", "BRL"
]);

const EXCLUDED_MARKET_SUFFIXES = ["UP", "DOWN", "BULL", "BEAR"];

const MARKET_NAMES = {
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
  BONK: "Bonk"
};

function isAllowedMarketInstrument(info) {
  const base = info.baseAsset;

  return (
    info.status === "TRADING" &&
    info.quoteAsset === "USDT" &&
    info.isSpotTradingAllowed !== false &&
    !EXCLUDED_MARKET_ASSETS.has(base) &&
    !EXCLUDED_MARKET_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

async function loadMarketUniverse() {
  if (state.marketUniverse.length) {
    renderMarketPicker();
    return;
  }

  try {
    const [exchangeInfo, tickers] = await Promise.all([
      fetchJson(`${REST_BASE}/api/v3/exchangeInfo`),
      fetchJson(`${REST_BASE}/api/v3/ticker/24hr`)
    ]);

    const allowed = new Map(
      exchangeInfo.symbols
        .filter(isAllowedMarketInstrument)
        .map((info) => [info.symbol, info])
    );

    state.marketUniverse = tickers
      .filter((ticker) => allowed.has(ticker.symbol))
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, 100)
      .map((ticker) => {
        const info = allowed.get(ticker.symbol);

        return {
          symbol: ticker.symbol,
          baseAsset: info.baseAsset,
          name: MARKET_NAMES[info.baseAsset] || info.baseAsset,
          price: Number(ticker.lastPrice),
          change: Number(ticker.priceChangePercent),
          volume: Number(ticker.quoteVolume)
        };
      });

    const select = $("tradeSymbolSelect");
    select.innerHTML = state.marketUniverse
      .map((item) => `<option value="${item.symbol}">${item.symbol}</option>`)
      .join("");

    if (state.marketUniverse.some((item) => item.symbol === state.currentSymbol)) {
      select.value = state.currentSymbol;
    } else if (state.marketUniverse.length) {
      state.currentSymbol = state.marketUniverse[0].symbol;
      select.value = state.currentSymbol;
    }

    renderMarketPicker();
    updateMarketPickerLabel();
  } catch (error) {
    console.error(error);
    $("marketPickerList").innerHTML =
      '<div class="market-picker-empty">Не удалось загрузить инструменты.</div>';
  }
}

function renderMarketPicker() {
  const query = ($("marketSearchInput")?.value || "").trim().toLowerCase();

  const filtered = state.marketUniverse.filter((item) =>
    `${item.symbol} ${item.baseAsset} ${item.name}`
      .toLowerCase()
      .includes(query)
  );

  $("marketPickerList").innerHTML = filtered.length
    ? filtered.map((item) => `
        <button type="button"
          class="market-picker-row ${item.symbol === state.currentSymbol ? "selected" : ""}"
          data-market-symbol="${item.symbol}">
          <span class="market-picker-coin">
            <strong>${item.baseAsset}/USDT</strong>
            <small>${item.name}</small>
          </span>
          <span class="market-picker-price">${formatPrice(item.price)}</span>
          <span class="market-picker-change ${item.change >= 0 ? "positive" : "negative"}">
            ${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}%
          </span>
        </button>
      `).join("")
    : '<div class="market-picker-empty">Монета не найдена.</div>';

  document.querySelectorAll("[data-market-symbol]").forEach((button) => {
    button.addEventListener("click", async () => {
      const symbol = button.dataset.marketSymbol;
      state.currentSymbol = symbol;
      $("tradeSymbolSelect").value = symbol;
      $("marketPickerDropdown").classList.add("hidden");
      $("marketSearchInput").value = "";
      updateMarketPickerLabel();
      renderMarketPicker();
      await loadTradingTerminal();
    });
  });
}

function updateMarketPickerLabel() {
  const item = state.marketUniverse.find(
    (market) => market.symbol === state.currentSymbol
  );

  const base = state.currentSymbol.replace("USDT", "");
  $("marketPickerSymbol").textContent = state.currentSymbol;
  $("marketPickerName").textContent =
    item?.name ? `${item.name} / Tether` : `${base} / Tether`;
}

async function loadTradingTerminal() {
  const symbol = $("tradeSymbolSelect").value || state.currentSymbol;
  state.currentSymbol = symbol;
  updateMarketPickerLabel();
  const activeInterval =
    document.querySelector("[data-chart-interval].active")?.dataset.chartInterval || "15m";

  state.currentSymbol = symbol;

  try {
    const [klines, ticker, depth, trades] = await Promise.all([
      fetchJson(`${REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${activeInterval}&limit=500`),
      fetchJson(`${REST_BASE}/api/v3/ticker/24hr?symbol=${symbol}`),
      fetchJson(`${REST_BASE}/api/v3/depth?symbol=${symbol}&limit=20`),
      fetchJson(`${REST_BASE}/api/v3/trades?symbol=${symbol}&limit=50`)
    ]);

    const lastPrice = Number(ticker.lastPrice);
    const change = Number(ticker.priceChangePercent);

    const marketItem = state.marketUniverse.find((item) => item.symbol === symbol);
    if (marketItem) {
      marketItem.price = lastPrice;
      marketItem.change = change;
    }
    const base = symbol.replace("USDT", "");

    $("terminalSymbolLabel").textContent = symbol;
    $("terminalBaseName").textContent = COIN_DISPLAY_NAMES[symbol] || `${base} / Tether`;
    $("terminalPrice").textContent = formatPrice(lastPrice);
    $("terminalOpen").textContent = formatPrice(ticker.openPrice);
    $("terminalHigh").textContent = formatPrice(ticker.highPrice);
    $("terminalLow").textContent = formatPrice(ticker.lowPrice);
    $("terminalVolume").textContent =
      new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })
        .format(Number(ticker.quoteVolume));
    $("terminalTradeCount").textContent = Number(ticker.count).toLocaleString("en-US");
    $("terminalChange").textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("terminalChange").className = change >= 0 ? "positive" : "negative";
    $("orderPrice").value = formatRawNumber(lastPrice);
    $("baseAssetSuffix").textContent = base;
    $("orderbookMid").textContent = formatPrice(lastPrice);
    $("orderbookDirection").textContent =
      `${change >= 0 ? "↑" : "↓"} ${formatPrice(ticker.weightedAvgPrice)}`;
    $("orderbookDirection").className = change >= 0 ? "positive" : "negative";

    updateTerminalBalances();
    renderProOrderbook(depth);
    renderProRecentTrades(trades);
    renderProfessionalChart(klines);
    renderOrders();
    renderTerminalAssets();
    renderTerminalTradeHistory();
    updateOrderCalculation();
  } catch (error) {
    console.error(error);
    showToast("Не удалось загрузить данные торгового терминала");
  }
}

function formatRawNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number >= 1000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(4);
  return number.toFixed(8);
}

function renderProfessionalChart(rows) {
  const container = $("terminalChart");

  if (!state.chart) {
    state.chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: "solid", color: "#0d1219" },
        textColor: "#748095",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(116,128,149,.10)" },
        horzLines: { color: "rgba(116,128,149,.10)" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: "#242b36",
        scaleMargins: { top: .06, bottom: .24 },
      },
      timeScale: {
        borderColor: "#242b36",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 7,
        barSpacing: 7,
        minBarSpacing: 1.5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
    });

    state.candleSeries = state.chart.addSeries(
      LightweightCharts.CandlestickSeries,
      {
        upColor: "#20c987",
        downColor: "#ff5f78",
        borderVisible: false,
        wickUpColor: "#20c987",
        wickDownColor: "#ff5f78",
        priceLineVisible: true,
        lastValueVisible: true,
      }
    );

    state.volumeSeries = state.chart.addSeries(
      LightweightCharts.HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        priceLineVisible: false,
        lastValueVisible: false,
      }
    );

    state.volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: .78, bottom: 0 },
    });

    state.chart.subscribeCrosshairMove((param) => {
      if (!param?.time || !param.seriesData) {
        updateChartOhlc(rows.at(-1));
        return;
      }

      const candle = param.seriesData.get(state.candleSeries);
      const volume = param.seriesData.get(state.volumeSeries);
      if (candle) {
        updateChartOhlc([
          0,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          volume?.value || 0,
        ]);
      }
    });

    new ResizeObserver(() => {
      if (state.chart) {
        state.chart.resize(container.clientWidth, container.clientHeight);
      }
    }).observe(container);
  }

  state.candleSeries.setData(
    rows.map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    }))
  );

  state.volumeSeries.setData(
    rows.map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      value: Number(row[5]),
      color: Number(row[4]) >= Number(row[1])
        ? "rgba(32,201,135,.55)"
        : "rgba(255,95,120,.55)",
    }))
  );

  updateChartOhlc(rows.at(-1));
  state.chart.timeScale().fitContent();
}

function updateChartOhlc(row) {
  if (!row) return;
  $("chartOpen").textContent = formatPrice(row[1]);
  $("chartHigh").textContent = formatPrice(row[2]);
  $("chartLow").textContent = formatPrice(row[3]);
  $("chartClose").textContent = formatPrice(row[4]);
  $("chartVolume").textContent =
    new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })
      .format(Number(row[5]));
}

function renderProOrderbook(depth) {
  const precision = Number($("orderbookPrecision").value) || .1;

  const prepareRows = (rows) => {
    let cumulative = 0;
    const normalized = rows.map(([price, quantity]) => {
      cumulative += Number(quantity);
      return {
        price: Math.round(Number(price) / precision) * precision,
        quantity: Number(quantity),
        total: cumulative,
      };
    });

    const maxTotal = Math.max(...normalized.map((item) => item.total), 1);
    return normalized.map((item) => ({
      ...item,
      depth: item.total / maxTotal * 100,
    }));
  };

  const asks = prepareRows([...depth.asks].reverse().slice(0, 13));
  const bids = prepareRows(depth.bids.slice(0, 13));

  $("asksList").innerHTML = asks.map((item) => `
    <div class="pro-orderbook-row" style="--depth-width:${item.depth}%">
      <span>${formatPrice(item.price)}</span>
      <span>${item.quantity.toFixed(5)}</span>
      <span>${item.total.toFixed(5)}</span>
    </div>
  `).join("");

  $("bidsList").innerHTML = bids.map((item) => `
    <div class="pro-orderbook-row" style="--depth-width:${item.depth}%">
      <span>${formatPrice(item.price)}</span>
      <span>${item.quantity.toFixed(5)}</span>
      <span>${item.total.toFixed(5)}</span>
    </div>
  `).join("");

  const bidTotal = bids.reduce((sum, item) => sum + item.quantity, 0);
  const askTotal = asks.reduce((sum, item) => sum + item.quantity, 0);
  const total = bidTotal + askTotal || 1;
  const bidPercent = bidTotal / total * 100;
  const askPercent = 100 - bidPercent;

  $("mobileBidRatio").textContent = `${bidPercent.toFixed(2)}%`;
  $("mobileAskRatio").textContent = `${askPercent.toFixed(2)}%`;
  $("mobileBidRatioBar").style.width = `${bidPercent}%`;
  $("mobileAskRatioBar").style.width = `${askPercent}%`;
}

function renderProRecentTrades(trades) {
  $("recentTradesList").innerHTML = trades.reverse().map((trade) => `
    <div class="pro-recent-row">
      <span class="${trade.isBuyerMaker ? "negative" : "positive"}">
        ${formatPrice(trade.price)}
      </span>
      <span>${Number(trade.qty).toFixed(5)}</span>
      <span>${new Date(trade.time).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}</span>
    </div>
  `).join("");
}

function updateTerminalBalances() {
  const usdt = state.portfolio.find((item) => item.asset === "USDT");
  const available = usdt?.amount || 0;
  const locked = state.orders
    .filter((order) => order.status === "Открыт")
    .reduce((sum, order) => sum + (order.side === "BUY" ? order.total : 0), 0);

  $("availableUsdt").textContent = `${available.toFixed(2)} USDT`;
  $("terminalAvailableBalance").textContent = `${available.toFixed(2)} USDT`;
  $("terminalLockedBalance").textContent = `${locked.toFixed(2)} USDT`;
  $("terminalAccountBalance").textContent =
    `${(available + locked).toFixed(2)} USDT`;
  $("terminalRealizedPnl").textContent =
    `${Number(localStorage.getItem("fastboot-realized-pnl") || 0).toFixed(2)} USDT`;
}

function calculateOrderAmountFromPercent(percent) {
  const usdt = state.portfolio.find((item) => item.asset === "USDT")?.amount || 0;
  const price = Number($("orderPrice").value) ||
    Number(String($("terminalPrice").textContent).replaceAll(",", ""));
  if (!(price > 0)) return;

  $("orderPercentSlider").value = String(percent);

  if (state.orderSide === "BUY") {
    $("orderAmount").value = ((usdt * percent / 100) / price).toFixed(8);
  } else {
    const asset = state.currentSymbol.replace("USDT", "");
    const amount = state.portfolio.find((item) => item.asset === asset)?.amount || 0;
    $("orderAmount").value = (amount * percent / 100).toFixed(8);
  }

  updateOrderCalculation();
}

function updateOrderCalculation() {
  const price = Number($("orderPrice").value) ||
    Number(String($("terminalPrice").textContent).replaceAll(",", ""));
  const amount = Number($("orderAmount").value) || 0;
  const total = price * amount;
  const fee = total * .001;

  $("orderTotal").textContent = `${total.toFixed(2)} USDT`;
  $("estimatedFee").textContent = `${fee.toFixed(2)} USDT`;

  const usdt = state.portfolio.find((item) => item.asset === "USDT")?.amount || 0;
  const asset = state.currentSymbol.replace("USDT", "");
  const assetAmount = state.portfolio.find((item) => item.asset === asset)?.amount || 0;

  $("mobileMaxBuy").textContent = `${usdt.toFixed(2)} USDT`;
  $("mobileBuyCost").textContent = `${total.toFixed(2)} USDT`;
  $("mobileMaxSell").textContent = `${assetAmount.toFixed(8)} ${asset}`;
  $("mobileSellCost").textContent = `${total.toFixed(2)} USDT`;
}

function placeLocalTerminalOrder(side) {
  state.orderSide = side;

  const type = $("orderType").value;
  const amount = Number($("orderAmount").value);
  const displayedPrice =
    Number(String($("terminalPrice").textContent).replaceAll(",", ""));
  const price = type === "MARKET"
    ? displayedPrice
    : Number($("orderPrice").value);

  if (!(amount > 0) || !(price > 0)) {
    showToast("Введите цену и количество");
    return;
  }

  const total = price * amount;
  const order = {
    date: new Date().toLocaleString("ru-RU"),
    symbol: state.currentSymbol,
    type,
    side,
    price,
    amount,
    total,
    status: type === "MARKET" ? "Исполнен локально" : "Открыт",
    stopPrice: Number($("stopPrice")?.value) || null,
    takeProfit: Number($("takeProfitPrice")?.value) || null,
    stopLoss: Number($("stopLossPrice")?.value) || null,
    postOnly: Boolean($("postOnly")?.checked),
  };

  state.orders.unshift(order);
  saveState();
  renderOrders();
  renderTerminalTradeHistory();
  updateTerminalBalances();
  $("orderAmount").value = "";
  $("orderPercentSlider").value = "0";
  updateOrderCalculation();
  showToast(`${side === "BUY" ? "Покупка" : "Продажа"} добавлена в локальную историю`);
}

function renderOrders() {
  const rows = state.orders.length
    ? state.orders.map((order) => `
      <div class="terminal-order-row">
        <span>${order.date}</span>
        <strong>${order.symbol}</strong>
        <span>${order.type}</span>
        <span class="${order.side === "BUY" ? "positive" : "negative"}">${order.side}</span>
        <span>${formatPrice(order.price)}</span>
        <span>${order.amount}</span>
        <span>${order.status}</span>
      </div>
    `).join("")
    : `<div class="terminal-empty-state"><strong>Ордеров пока нет</strong></div>`;

  $("ordersHistory").innerHTML = rows;

  const openCount = state.orders.filter((order) => order.status === "Открыт").length;
  $("openOrdersTabCount").textContent = `(${openCount})`;
  $("mobileOpenOrdersCount").textContent = `(${openCount})`;
  $("mobileBasicOrdersCount").textContent = `(${openCount})`;
  $("mobileConditionalOrdersCount").textContent =
    `(${state.orders.filter((order) => order.type === "STOP").length})`;

  $("openOrdersContent").innerHTML = openCount
    ? state.orders
        .filter((order) => order.status === "Открыт")
        .map((order) => `
          <div class="terminal-order-row">
            <span>${order.date}</span>
            <strong>${order.symbol}</strong>
            <span>${order.type}</span>
            <span class="${order.side === "BUY" ? "positive" : "negative"}">${order.side}</span>
            <span>${formatPrice(order.price)}</span>
            <span>${order.amount}</span>
            <span>${order.status}</span>
          </div>
        `).join("")
    : `<div class="terminal-empty-state"><strong>Открытых ордеров нет</strong></div>`;
}

function renderTerminalTradeHistory() {
  const filled = state.orders.filter((order) =>
    String(order.status).includes("Исполнен")
  );

  $("terminalTradeHistory").innerHTML = filled.length
    ? filled.map((order) => `
      <div class="terminal-order-row">
        <span>${order.date}</span>
        <strong>${order.symbol}</strong>
        <span class="${order.side === "BUY" ? "positive" : "negative"}">${order.side}</span>
        <span>${formatPrice(order.price)}</span>
        <span>${order.amount}</span>
        <span>${order.total.toFixed(2)}</span>
        <span>${order.status}</span>
      </div>
    `).join("")
    : `<div class="terminal-empty-state"><strong>Исполненных сделок пока нет</strong></div>`;
}

function renderTerminalAssets() {
  $("terminalAssetsList").innerHTML = state.portfolio.map((item) => `
    <article class="terminal-asset-card">
      <span>${item.name}</span>
      <strong>${item.asset}: ${item.amount.toFixed(item.asset === "USDT" ? 2 : 8)}</strong>
    </article>
  `).join("");
}

$("tradeSymbolSelect").addEventListener("change", () => {
  state.currentSymbol = $("tradeSymbolSelect").value;
  updateMarketPickerLabel();
  loadTradingTerminal();
});

document.querySelectorAll("[data-chart-interval]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-chart-interval]").forEach((item) =>
      item.classList.toggle("active", item === button)
    );
    loadTradingTerminal();
  });
});

$("fitChartButton").addEventListener("click", () => {
  state.chart?.timeScale().fitContent();
});

$("refreshTerminalButton").addEventListener("click", loadTradingTerminal);
$("orderbookPrecision").addEventListener("change", loadTradingTerminal);

document.querySelectorAll("[data-order-type]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-order-type]").forEach((item) =>
      item.classList.toggle("active", item === button)
    );

    const type = button.dataset.orderType;
    $("orderType").value = type;
    $("stopPriceField").classList.toggle("hidden", type !== "STOP");
    $("orderPrice").disabled = type === "MARKET";
    $("orderPrice").placeholder = type === "MARKET" ? "Рыночная цена" : "";
    updateOrderCalculation();
  });
});

["orderPrice", "orderAmount"].forEach((id) => {
  $(id).addEventListener("input", updateOrderCalculation);
});

$("orderPercentSlider").addEventListener("input", (event) => {
  calculateOrderAmountFromPercent(Number(event.target.value));
});

document.querySelectorAll("[data-percent]").forEach((button) => {
  button.addEventListener("click", () => {
    calculateOrderAmountFromPercent(Number(button.dataset.percent));
  });
});

$("takeProfitStopLoss").addEventListener("change", (event) => {
  $("tpSlFields").classList.toggle("hidden", !event.target.checked);
});

$("buyOrderButton").addEventListener("click", () => placeLocalTerminalOrder("BUY"));
$("sellOrderButton").addEventListener("click", () => placeLocalTerminalOrder("SELL"));

$("terminalBottomTabs").querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    $("terminalBottomTabs").querySelectorAll("button").forEach((item) =>
      item.classList.toggle("active", item === button)
    );

    const map = {
      positions: "positionsContent",
      "open-orders": "openOrdersContent",
      "order-history": "orderHistoryContent",
      "trade-history": "tradeHistoryContent",
      assets: "assetsContent",
    };

    document.querySelectorAll(".terminal-bottom-content").forEach((content) =>
      content.classList.toggle("active", content.id === map[button.dataset.bottomTab])
    );
  });
});

$("terminalAssetsShortcut").addEventListener("click", () => {
  document.querySelector('[data-bottom-tab="assets"]').click();
});

$("terminalOrdersShortcut").addEventListener("click", () => {
  document.querySelector('[data-bottom-tab="order-history"]').click();
});

async function loadMarketAnalysis() {
  const symbol=$("analysisCoinSelect").value;
  try {
    const [ticker,depth]=await Promise.all([fetchJson(`${REST_BASE}/api/v3/ticker/24hr?symbol=${symbol}`),fetchJson(`${REST_BASE}/api/v3/depth?symbol=${symbol}&limit=50`)]);
    const change=Number(ticker.priceChangePercent), high=Number(ticker.highPrice), low=Number(ticker.lowPrice), last=Number(ticker.lastPrice);
    const volatility=(high-low)/Math.max(low,.00000001)*100;
    const range=(last-low)/Math.max(high-low,.00000001)*100;
    const bidVolume=depth.bids.reduce((s,x)=>s+Number(x[1]),0), askVolume=depth.asks.reduce((s,x)=>s+Number(x[1]),0), demand=bidVolume/(bidVolume+askVolume)*100;
    $("analysisChange").textContent=`${change>=0?"+":""}${change.toFixed(2)}%`; $("analysisChange").className=change>=0?"positive":"negative";
    $("analysisVolatility").textContent=`${volatility.toFixed(2)}%`; $("analysisVolume").textContent=`${new Intl.NumberFormat("en-US",{notation:"compact"}).format(Number(ticker.quoteVolume))} USDT`; $("analysisRange").textContent=`${range.toFixed(1)}%`;
    $("demandBar").style.width=`${demand}%`; $("demandValue").textContent=`${demand.toFixed(1)}%`; $("supplyValue").textContent=`${(100-demand).toFixed(1)}%`;
    const momentum=Math.max(0,Math.min(100,50+change*4)), volumeScore=Math.max(5,Math.min(100,Math.log10(Math.max(Number(ticker.quoteVolume),1))*10)), volScore=Math.min(100,volatility*8);
    [["momentum",momentum],["volume",volumeScore],["volatility",volScore]].forEach(([name,val])=>{$(`${name}Bar`).style.width=`${val}%`;$(`${name}Value`).textContent=`${val.toFixed(0)}`});
    $("analysisNarrative").textContent=`${symbol.replace("USDT","/USDT")} за 24 часа ${change>=0?"показывает положительную":"показывает отрицательную"} динамику ${Math.abs(change).toFixed(2)}%. Текущая цена находится на ${range.toFixed(1)}% суточного диапазона. Соотношение объёма заявок указывает на ${demand>55?"преобладание спроса":demand<45?"преобладание предложения":"относительный баланс спроса и предложения"}. Волатильность составляет ${volatility.toFixed(2)}%.`;
  } catch { showToast("Не удалось загрузить анализ"); }
}
$("refreshAnalysisButton").addEventListener("click",loadMarketAnalysis);
$("analysisCoinSelect").addEventListener("change",loadMarketAnalysis);

function renderJournal() {
  $("journalOrdersCount").textContent=state.orders.length;
  $("journalBuyCount").textContent=state.orders.filter(o=>o.side==="BUY").length;
  $("journalSellCount").textContent=state.orders.filter(o=>o.side==="SELL").length;
  $("journalTurnover").textContent=`${state.orders.reduce((s,o)=>s+o.total,0).toFixed(2)} USDT`;
  $("journalOrders").innerHTML=state.orders.length?state.orders.map(o=>`<div class="order-history-row"><span>${o.date}</span><strong>${o.symbol}</strong><span>${o.type}</span><span class="${o.side==="BUY"?"positive":"negative"}">${o.side}</span><span>${formatPrice(o.price)}</span><span>${o.amount}</span><span>${o.total.toFixed(2)}</span></div>`).join(""):"Сделок пока нет";
  $("journalOrders").classList.toggle("empty-list",!state.orders.length);
}

$("saveProfileButton").addEventListener("click",()=>{
  const name=$("settingsName").value.trim(); if(!name)return;
  const users=JSON.parse(localStorage.getItem("fastboot-users")||"[]");
  const user=users.find(u=>u.id===session.id); if(user)user.name=name;
  localStorage.setItem("fastboot-users",JSON.stringify(users)); session.name=name; localStorage.setItem("fastboot-session",JSON.stringify(session)); initializeUser(); showToast("Профиль обновлён");
});

initializeUser(); loadPrices(); renderOrders(); renderJournal();


$("tradingHomeButton")?.addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
});

$("fitChartButton")?.addEventListener("click", () => {
  state.chart?.timeScale().fitContent();
});

document.querySelectorAll(".order-type-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".order-type-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    $("orderType").value = button.dataset.orderType;
    const market = button.dataset.orderType === "MARKET";
    $("orderPrice").disabled = market;
    $("orderPrice").placeholder = market ? "Рыночная цена" : "Цена";
  });
});

document.querySelectorAll(".amount-percent-row button").forEach((button) => {
  button.addEventListener("click", () => {
    const percent = Number(button.dataset.percent) / 100;
    const available = state.portfolio.find((item) => item.asset === "USDT")?.amount || 0;
    const price = Number($("orderPrice").value) || Number($("terminalPrice").textContent.replaceAll(",", ""));
    if (!(price > 0)) return;
    $("orderAmount").value = ((available * percent) / price).toFixed(8);
    $("orderAmount").dispatchEvent(new Event("input"));
  });
});


$("mobileTradingMenuButton")?.addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
});

$("mobileOrdersIconButton")?.addEventListener("click", () => {
  document.querySelector('[data-bottom-tab="order-history"]')?.click();
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
});

document.querySelectorAll("[data-mobile-bottom]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-mobile-bottom]").forEach((item) =>
      item.classList.toggle("active", item === button)
    );

    const map = {
      "open-orders": "open-orders",
      positions: "positions",
      bots: "positions",
    };

    document.querySelector(`[data-bottom-tab="${map[button.dataset.mobileBottom]}"]`)?.click();
  });
});

function updateFundingCountdown() {
  const now = new Date();
  const totalSeconds = (4 * 60 * 60) - ((now.getUTCHours() % 4) * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const element = $("mobileFundingRate");
  if (element) element.textContent = `0.0000% / ${hours}:${minutes}:${seconds}`;
}

updateFundingCountdown();
setInterval(updateFundingCountdown, 1000);


$("marketPickerButton")?.addEventListener("click", async (event) => {
  event.stopPropagation();
  const dropdown = $("marketPickerDropdown");
  const willOpen = dropdown.classList.contains("hidden");

  dropdown.classList.toggle("hidden");

  if (willOpen) {
    await loadMarketUniverse();
    $("marketSearchInput")?.focus();
  }
});

$("marketSearchInput")?.addEventListener("input", renderMarketPicker);

$("marketPickerDropdown")?.addEventListener("click", (event) => {
  event.stopPropagation();
});

document.addEventListener("click", () => {
  $("marketPickerDropdown")?.classList.add("hidden");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("marketPickerDropdown")?.classList.add("hidden");
  }
});

loadMarketUniverse();
