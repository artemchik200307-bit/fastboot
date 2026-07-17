const REST_BASE = "https://data-api.binance.vision";
const WS_BASE = "wss://stream.binance.com:9443/ws";
const $ = (id) => document.getElementById(id);

const supabaseClient = window.fastbootSupabase;
const authUser = window.fastbootUser;
const userProfile = window.fastbootProfile;
const userWallet = window.fastbootWallet;

if (!supabaseClient || !authUser || !userProfile) {
  throw new Error("Dashboard запущен до завершения авторизации.");
}

const storageKey = (name) => `fastboot-${authUser.id}-${name}`;

const state = {
  section: "overview",
  portfolio: [
    { asset: "USDT", name: "Tether", amount: Number(userWallet?.spot_balance || 0) },
  ],
  deposits: [],
  withdrawals: [],
  transfers: [],
  transactions: [],
  fundingRequests: [],
  adminUsers: [],
  adminFundingRequests: [],
  adminOverview: null,
  botBalance: Number(userWallet?.bot_balance || 0),
  botRunning: localStorage.getItem(storageKey("bot-running")) === "true",
  orders: JSON.parse(localStorage.getItem(storageKey("orders")) || "[]"),
  prices: {},
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  chartResizeObserver: null,
  tradeSocket: null,
  terminalSocketReconnectTimer: null,
  terminalSocketGeneration: 0,
  mobileChart: null,
  mobileChartSeries: null,
  mobileChartVolumeSeries: null,
  mobileChartInterval: "15m",
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
  localStorage.setItem(storageKey("bot-running"), String(state.botRunning));
  localStorage.setItem(storageKey("orders"), JSON.stringify(state.orders));
}

function showToast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $("toast").classList.add("hidden"), 2300);
}

function openSection(id) {
  state.section = id;
  localStorage.setItem("fastboot-active-section", id);

  if (id !== "trading") {
    document.body.classList.remove("mobile-bottom-drawer-open");
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }
  document.body.classList.toggle("trading-mode", id === "trading");
  document.querySelectorAll(".dashboard-section").forEach((el) => el.classList.toggle("active", el.id === id));
  document.querySelectorAll(".nav-item[data-section]").forEach((el) => el.classList.toggle("active", el.dataset.section === id));
  $("pageTitle").textContent = titles[id] || "FASTBOOT";
  $("sidebar").classList.remove("open");
  document.body.classList.toggle("trading-mode", id === "trading");
  if (id === "trading") {
    requestAnimationFrame(() => {
      requestAnimationFrame(loadTradingTerminal);
    });
  }
  if (id !== "trading") {
    stopTerminalRealtimeStream();
  }
  if (id === "market-analysis") loadMarketAnalysis();
  if (id === "journal") renderJournal();
  if (id === "admin") { if (userProfile.role !== "admin") { showToast("Нет доступа"); openSection("overview"); return; } loadAdminPanel(); }
  const dashboardScroller = document.querySelector(".dashboard-main");

  if (id !== "trading" && dashboardScroller) {
    dashboardScroller.scrollTo({ top: 0, behavior: "auto" });
  } else {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

document.querySelectorAll("[data-section]").forEach((btn) => btn.addEventListener("click", () => openSection(btn.dataset.section)));
$("menuButton").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("logoutButton").addEventListener("click", async () => {
  $("logoutButton").disabled = true;

  try {
    await supabaseClient.auth.signOut();
  } catch (error) {
    console.error("Ошибка выхода:", error);
  } finally {
    window.location.replace("login.html");
  }
});

function initializeUser() {
  const username =
    userProfile.username ||
    authUser.user_metadata?.username ||
    authUser.email?.split("@")[0] ||
    "User";

  const email = userProfile.email || authUser.email || "";
  const publicId =
    userProfile.fastboot_id ||
    `FB-${authUser.id.replaceAll("-", "").slice(0, 10).toUpperCase()}`;

  $("profileName").textContent = username;
  $("profileId").textContent = `ID: ${publicId}`;
  $("profileAvatar").textContent = username.charAt(0).toUpperCase();

  $("accountOwner").textContent = username;
  $("accountEmail").textContent =
    `${email}${userProfile.role === "admin" ? " · Administrator" : ""}`;
  $("accountId").textContent = publicId;

  $("settingsName").value = username;
  $("settingsEmail").value = email;
  $("adminNavButton")?.classList.toggle("hidden", userProfile.role !== "admin");
}

function applySupabaseWalletToPortfolio() {
  const usdt = state.portfolio.find((item) => item.asset === "USDT");

  if (usdt) {
    usdt.amount = Number(userWallet?.spot_balance || 0);
  }

  state.botBalance = Number(userWallet?.bot_balance || 0);
}


async function loadSupabaseAccountData() {
  const [
    walletResult,
    fundingResult,
    transactionResult,
    transferResult,
  ] = await Promise.all([
    supabaseClient
      .from("wallets")
      .select("user_id, spot_balance, bot_balance, currency, updated_at")
      .eq("user_id", authUser.id)
      .single(),

    supabaseClient
      .from("funding_requests")
      .select("id, type, amount, asset, status, details, created_at")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: false })
      .limit(50),

    supabaseClient
      .from("transactions")
      .select("id, type, amount, asset, status, description, created_at")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: false })
      .limit(100),

    supabaseClient
      .from("wallet_transfers")
      .select("id, from_wallet, to_wallet, amount, created_at")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (walletResult.error) throw walletResult.error;
  if (fundingResult.error) throw fundingResult.error;
  if (transactionResult.error) throw transactionResult.error;
  if (transferResult.error) throw transferResult.error;

  Object.assign(userWallet, walletResult.data);

  state.deposits = (fundingResult.data || []).filter(
    (item) => item.type === "deposit"
  );

  state.withdrawals = (fundingResult.data || []).filter(
    (item) => item.type === "withdraw"
  );

  state.fundingRequests = fundingResult.data || [];
  state.transactions = transactionResult.data || [];
  state.transfers = transferResult.data || [];

  applySupabaseWalletToPortfolio();
  renderAccount();
}

function formatOperationStatus(status) {
  const map = {
    pending: "Ожидает",
    approved: "Одобрено",
    completed: "Выполнено",
    rejected: "Отклонено",
    cancelled: "Отменено",
  };

  return map[status] || status || "—";
}

function formatDateTime(value) {
  if (!value) return "—";

  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const spotBalance = Number(userWallet?.spot_balance || 0);
  const botBalance = Number(userWallet?.bot_balance || 0);
  const total = spotBalance + botBalance;

  $("totalBalance").textContent =
    `$${total.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  $("portfolioList").innerHTML = `
    <div class="portfolio-row">
      <span class="asset-name">
        <strong>USDT</strong>
        <span>Основной счёт</span>
      </span>
      <strong>${spotBalance.toFixed(2)}</strong>
      <span>1.00</span>
      <span>$${spotBalance.toFixed(2)}</span>
    </div>
    <div class="portfolio-row">
      <span class="asset-name">
        <strong>USDT</strong>
        <span>AI Bot Wallet</span>
      </span>
      <strong>${botBalance.toFixed(2)}</strong>
      <span>1.00</span>
      <span>$${botBalance.toFixed(2)}</span>
    </div>
  `;

  const spotPercent = total > 0 ? (spotBalance / total) * 100 : 0;
  const botPercent = total > 0 ? (botBalance / total) * 100 : 0;

  $("allocationBars").innerHTML = `
    <div class="allocation-item">
      <div><span>Основной счёт</span><strong>${spotPercent.toFixed(1)}%</strong></div>
      <div class="allocation-track">
        <div class="allocation-fill" style="width:${spotPercent}%"></div>
      </div>
    </div>
    <div class="allocation-item">
      <div><span>AI Bot</span><strong>${botPercent.toFixed(1)}%</strong></div>
      <div class="allocation-track">
        <div class="allocation-fill" style="width:${botPercent}%"></div>
      </div>
    </div>
  `;

  renderOperations();
  renderBot();
  updateTerminalBalances();
}

function renderOperations() {
  const operationHtml = (items) => items.length
    ? items.slice(0, 8).map((item) => `
      <div class="operation-row">
        <div>
          <strong>${Number(item.amount).toFixed(2)} ${item.asset || "USDT"}</strong>
          <br>
          <span>${formatDateTime(item.created_at)}</span>
        </div>
        <div class="operation-status">
          <strong>${formatOperationStatus(item.status)}</strong>
          <span>${item.details || ""}</span>
        </div>
      </div>
    `).join("")
    : '<div class="empty-list">Операций пока нет</div>';

  $("depositHistory").innerHTML = operationHtml(state.deposits);
  $("withdrawHistory").innerHTML = operationHtml(state.withdrawals);
}


const FASTBOOT_TRC20_ADDRESS = "TVwAj44gxbPFTDH3KifsmqjfCtF54tj4DC";
const FASTBOOT_MIN_DEPOSIT = 10;
const FASTBOOT_MIN_WITHDRAW = 10;

function copyText(value, successMessage = "Скопировано") {
  navigator.clipboard.writeText(value)
    .then(() => showToast(successMessage))
    .catch(() => showToast("Не удалось скопировать"));
}

function openMoneyModal(type) {
  if (type === "exchange") {
    $("modalTitle").textContent = "Перевод между счетами";
    $("modalBody").innerHTML = `
      <div class="modal-form">
        <label>Направление
          <select id="modalTransferDirection">
            <option value="spot_to_bot">Основной счёт → AI Bot</option>
            <option value="bot_to_spot">AI Bot → Основной счёт</option>
          </select>
        </label>
        <label>Сумма USDT
          <input id="modalAmount" type="number" step="0.01" min="0.01">
        </label>
        <button id="confirmModalAction" class="primary-action" type="button">
          Выполнить перевод
        </button>
      </div>
    `;
  } else if (type === "deposit") {
    const qrUrl =
      "https://api.qrserver.com/v1/create-qr-code/" +
      `?size=220x220&data=${encodeURIComponent(FASTBOOT_TRC20_ADDRESS)}`;

    $("modalTitle").textContent = "Пополнение USDT";

    $("modalBody").innerHTML = `
      <div class="crypto-funding-card">
        <div class="crypto-funding-summary">
          <div><span>Монета</span><strong>USDT</strong></div>
          <div><span>Сеть</span><strong>TRC20</strong></div>
          <div><span>Минимум</span><strong>${FASTBOOT_MIN_DEPOSIT} USDT</strong></div>
        </div>

        <div class="crypto-qr-wrap">
          <img src="${qrUrl}" alt="QR-код USDT TRC20" width="220" height="220">
        </div>

        <div class="crypto-address-box">
          <span>Адрес для пополнения</span>
          <button id="copyDepositAddressButton" type="button" class="crypto-address-button">
            <strong>${FASTBOOT_TRC20_ADDRESS}</strong>
            <small>Нажмите, чтобы скопировать</small>
          </button>
        </div>

        <div class="crypto-warning">
          <strong>Важно</strong>
          <p>Отправляйте только USDT в сети TRC20.</p>
          <p>Перевод в другой сети может быть потерян.</p>
          <p>Зачисление выполняется после проверки администратора.</p>
        </div>

        <div class="modal-form crypto-confirm-form">
          <label>Отправленная сумма USDT
            <input id="modalAmount" type="number" step="0.01"
              min="${FASTBOOT_MIN_DEPOSIT}"
              placeholder="Минимум ${FASTBOOT_MIN_DEPOSIT}">
          </label>

          <label>TXID / Hash транзакции
            <input id="modalTxid" type="text" minlength="20" maxlength="150"
              autocomplete="off" placeholder="Вставьте TXID после перевода">
          </label>

          <button id="confirmModalAction" class="primary-action" type="button">
            Отправить заявку
          </button>
        </div>

        <small class="crypto-processing-note">
          Ручная обработка обычно занимает 5–30 минут.
        </small>
      </div>
    `;

    $("copyDepositAddressButton").addEventListener(
      "click",
      () => copyText(FASTBOOT_TRC20_ADDRESS, "Адрес скопирован")
    );
  } else {
    $("modalTitle").textContent = "Вывод USDT TRC20";

    $("modalBody").innerHTML = `
      <div class="crypto-funding-card">
        <div class="crypto-funding-summary">
          <div><span>Монета</span><strong>USDT</strong></div>
          <div><span>Сеть</span><strong>TRC20</strong></div>
          <div><span>Минимум</span><strong>${FASTBOOT_MIN_WITHDRAW} USDT</strong></div>
        </div>

        <div class="crypto-warning">
          <strong>Проверьте адрес</strong>
          <p>Вывод выполняется только в сети TRC20.</p>
          <p>Средства должны находиться на основном счёте.</p>
        </div>

        <div class="modal-form">
          <label>Адрес USDT TRC20
            <input id="modalWalletAddress" type="text" maxlength="60"
              autocomplete="off" placeholder="T...">
          </label>

          <label>Сумма USDT
            <input id="modalAmount" type="number" step="0.01"
              min="${FASTBOOT_MIN_WITHDRAW}"
              placeholder="Минимум ${FASTBOOT_MIN_WITHDRAW}">
          </label>

          <button id="confirmModalAction" class="primary-action" type="button">
            Создать заявку
          </button>
        </div>
      </div>
    `;
  }

  $("actionModal").classList.remove("hidden");
  $("confirmModalAction").addEventListener(
    "click",
    () => processMoneyAction(type),
    { once: true }
  );
}

async function processMoneyAction(type) {
  const amount = Number($("modalAmount")?.value);
  const button = $("confirmModalAction");

  if (!(amount > 0)) {
    showToast("Введите корректную сумму");
    return;
  }

  if (type === "deposit" && amount < FASTBOOT_MIN_DEPOSIT) {
    showToast(`Минимальное пополнение — ${FASTBOOT_MIN_DEPOSIT} USDT`);
    return;
  }

  if (type === "withdraw" && amount < FASTBOOT_MIN_WITHDRAW) {
    showToast(`Минимальный вывод — ${FASTBOOT_MIN_WITHDRAW} USDT`);
    return;
  }

  button.disabled = true;

  try {
    if (type === "exchange") {
      const { error } = await supabaseClient.rpc(
        "transfer_wallet_balance",
        {
          p_direction: $("modalTransferDirection").value,
          p_amount: amount,
        }
      );

      if (error) throw error;
      showToast("Перевод выполнен");
    } else if (type === "deposit") {
      const txid = $("modalTxid")?.value.trim();

      if (!txid || txid.length < 20) {
        showToast("Введите корректный TXID");
        return;
      }

      const { error } = await supabaseClient.rpc(
        "request_trc20_deposit",
        {
          p_amount: amount,
          p_txid: txid,
        }
      );

      if (error) throw error;
      showToast("Заявка на пополнение отправлена");
    } else {
      const walletAddress = $("modalWalletAddress")?.value.trim();

      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddress || "")) {
        showToast("Введите корректный TRC20-адрес");
        return;
      }

      const { error } = await supabaseClient.rpc(
        "request_trc20_withdrawal",
        {
          p_amount: amount,
          p_wallet_address: walletAddress,
        }
      );

      if (error) throw error;
      showToast("Заявка на вывод создана");
    }

    $("actionModal").classList.add("hidden");
    await loadSupabaseAccountData();
  } catch (error) {
    console.error("Ошибка финансовой операции:", error);
    showToast(error?.message || "Не удалось выполнить операцию");
  } finally {
    button.disabled = false;
  }
}

$("depositButton").addEventListener("click", () => openMoneyModal("deposit"));
$("withdrawButton").addEventListener("click", () => openMoneyModal("withdraw"));
$("exchangeButton").addEventListener("click", () => openMoneyModal("exchange"));
$("closeModalButton").addEventListener(
  "click",
  () => $("actionModal").classList.add("hidden")
);

function renderBot() {
  $("botBalance").textContent = `$${state.botBalance.toFixed(2)}`;
  $("botStatus").textContent = state.botRunning ? "Активен" : "Остановлен";
  $("botStatus").className = state.botRunning ? "positive" : "";
  $("botStatusDescription").textContent = state.botRunning ? "Алгоритм выполняет мониторинг рынка" : "Торговля не запущена";
  $("toggleBotButton").textContent = state.botRunning ? "Остановить торговлю" : "Запустить торговлю";
}

async function transferBotFunds(direction) {
  const amount = Number($("botTransferAmount").value);

  if (!(amount > 0)) {
    showToast("Введите сумму");
    return;
  }

  try {
    const { error } = await supabaseClient.rpc(
      "transfer_wallet_balance",
      {
        p_direction: direction,
        p_amount: amount,
      }
    );

    if (error) throw error;

    $("botTransferAmount").value = "";
    await loadSupabaseAccountData();

    showToast(
      direction === "spot_to_bot"
        ? "Средства переведены на счёт бота"
        : "Средства возвращены на основной счёт"
    );
  } catch (error) {
    console.error("Ошибка перевода:", error);
    showToast(error?.message || "Не удалось выполнить перевод");
  }
}

$("transferToBotButton").addEventListener(
  "click",
  () => transferBotFunds("spot_to_bot")
);

$("transferFromBotButton").addEventListener(
  "click",
  () => transferBotFunds("bot_to_spot")
);
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
    const [klines, ticker, depth] = await Promise.all([
      fetchJson(`${REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${activeInterval}&limit=500`),
      fetchJson(`${REST_BASE}/api/v3/ticker/24hr?symbol=${symbol}`),
      fetchJson(`${REST_BASE}/api/v3/depth?symbol=${symbol}&limit=20`)
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
    renderProfessionalChart(klines);
    renderOrders();
    renderTerminalAssets();
    renderTerminalTradeHistory();
    updateOrderCalculation();
    startTerminalRealtimeStream(symbol, activeInterval);
  } catch (error) {
    console.error("Ошибка торгового терминала:", error);

    const chartContainer = $("terminalChart");
    if (chartContainer && !state.chart) {
      chartContainer.innerHTML = `
        <div class="terminal-empty-state">
          <strong>Не удалось загрузить график</strong>
          <span>${escapeHtml(error?.message || "Ошибка рыночного API")}</span>
        </div>
      `;
    }

    showToast(`Не удалось загрузить терминал: ${error?.message || "неизвестная ошибка"}`);
  }
}

function formatRawNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number >= 1000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(4);
  return number.toFixed(8);
}


function stopTerminalRealtimeStream() {
  state.terminalSocketGeneration += 1;

  if (state.terminalSocketReconnectTimer) {
    clearTimeout(state.terminalSocketReconnectTimer);
    state.terminalSocketReconnectTimer = null;
  }

  if (state.tradeSocket) {
    state.tradeSocket.onopen = null;
    state.tradeSocket.onmessage = null;
    state.tradeSocket.onerror = null;
    state.tradeSocket.onclose = null;

    try {
      state.tradeSocket.close(1000, "Terminal stream changed");
    } catch {
      // Socket may already be closed.
    }

    state.tradeSocket = null;
  }
}

function startTerminalRealtimeStream(symbol, interval) {
  stopTerminalRealtimeStream();

  if (state.section !== "trading") return;

  const generation = state.terminalSocketGeneration;
  const streamSymbol = symbol.toLowerCase();
  const streams = [
    `${streamSymbol}@kline_${interval}`,
    `${streamSymbol}@ticker`,
    `${streamSymbol}@depth20@1000ms`,
  ].join("/");

  const socket = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${streams}`
  );

  state.tradeSocket = socket;

  socket.onopen = () => {
    const live = document.querySelector(".terminal-live-status");
    live?.classList.remove("connection-error");
    live?.classList.add("connection-live");

    const text = live?.querySelector("span");
    if (text) text.textContent = "LIVE";
  };

  socket.onmessage = (event) => {
    if (
      generation !== state.terminalSocketGeneration ||
      state.section !== "trading" ||
      state.currentSymbol !== symbol
    ) {
      return;
    }

    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const stream = payload.stream || "";
    const data = payload.data || {};

    if (stream.includes("@kline_")) {
      updateRealtimeCandle(data.k);
      return;
    }

    if (stream.endsWith("@ticker")) {
      updateRealtimeTicker(data);
      return;
    }

    if (stream.includes("@depth20")) {
      renderProOrderbook({
        asks: data.asks || data.a || [],
        bids: data.bids || data.b || [],
      });
    }
  };

  socket.onerror = () => {
    const live = document.querySelector(".terminal-live-status");
    live?.classList.remove("connection-live");
    live?.classList.add("connection-error");

    const text = live?.querySelector("span");
    if (text) text.textContent = "RECONNECT";
  };

  socket.onclose = () => {
    if (
      generation !== state.terminalSocketGeneration ||
      state.section !== "trading" ||
      state.currentSymbol !== symbol
    ) {
      return;
    }

    const live = document.querySelector(".terminal-live-status");
    live?.classList.remove("connection-live");
    live?.classList.add("connection-error");

    const text = live?.querySelector("span");
    if (text) text.textContent = "RECONNECT";

    state.terminalSocketReconnectTimer = setTimeout(() => {
      if (
        generation === state.terminalSocketGeneration &&
        state.section === "trading" &&
        state.currentSymbol === symbol
      ) {
        startTerminalRealtimeStream(symbol, interval);
      }
    }, 2000);
  };
}

function updateRealtimeCandle(kline) {
  if (!kline || !state.candleSeries || !state.volumeSeries) return;

  const time = Math.floor(Number(kline.t) / 1000);
  const open = Number(kline.o);
  const high = Number(kline.h);
  const low = Number(kline.l);
  const close = Number(kline.c);
  const volume = Number(kline.v);

  state.candleSeries.update({
    time,
    open,
    high,
    low,
    close,
  });

  state.volumeSeries.update({
    time,
    value: volume,
    color:
      close >= open
        ? "rgba(32,201,135,.52)"
        : "rgba(255,95,120,.52)",
  });

  updateChartOhlc([0, open, high, low, close, volume]);
}

function updateRealtimeTicker(ticker) {
  if (!ticker) return;

  const lastPrice = Number(ticker.c);
  const change = Number(ticker.P);
  const base = state.currentSymbol.replace("USDT", "");

  if (Number.isFinite(lastPrice)) {
    $("terminalPrice").textContent = formatPrice(lastPrice);
    $("orderbookMid").textContent = formatPrice(lastPrice);

    if ($("orderType")?.value === "MARKET" || !$("orderPrice")?.value) {
      $("orderPrice").value = formatRawNumber(lastPrice);
    }
  }

  if (Number.isFinite(change)) {
    $("terminalChange").textContent =
      `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("terminalChange").className =
      change >= 0 ? "positive" : "negative";
  }

  $("terminalOpen").textContent = formatPrice(ticker.o);
  $("terminalHigh").textContent = formatPrice(ticker.h);
  $("terminalLow").textContent = formatPrice(ticker.l);
  $("terminalVolume").textContent =
    new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(Number(ticker.q));
  $("terminalTradeCount").textContent =
    Number(ticker.n || 0).toLocaleString("en-US");

  const weightedPrice = Number(ticker.w);
  $("orderbookDirection").textContent =
    `${change >= 0 ? "↑" : "↓"} ${formatPrice(weightedPrice)}`;
  $("orderbookDirection").className =
    change >= 0 ? "positive" : "negative";

  const marketItem = state.marketUniverse.find(
    (item) => item.symbol === state.currentSymbol
  );

  if (marketItem) {
    marketItem.price = lastPrice;
    marketItem.change = change;
  }

  state.prices[base] = lastPrice;
  updateOrderCalculation();
}

function renderProfessionalChart(rows) {
  const container = $("terminalChart");

  if (!container || !Array.isArray(rows) || !rows.length) {
    console.error("Нет контейнера или данных для графика");
    return;
  }

  if (!window.LightweightCharts) {
    container.innerHTML =
      '<div class="terminal-empty-state"><strong>Библиотека графика не загрузилась</strong></div>';
    return;
  }

  const containerWidth = Math.max(container.clientWidth, 320);
  const containerHeight = Math.max(container.clientHeight, 320);

  if (!state.chart) {
    state.chart = LightweightCharts.createChart(container, {
      width: containerWidth,
      height: containerHeight,
      layout: {
        background: { type: "solid", color: "#0d1219" },
        textColor: "#8490a2",
        attributionLogo: false,
      },
      localization: {
        locale: "ru-RU",
      },
      grid: {
        vertLines: { color: "rgba(116,128,149,.10)" },
        horzLines: { color: "rgba(116,128,149,.10)" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        visible: true,
        borderColor: "#242b36",
        autoScale: true,
        scaleMargins: {
          top: 0.06,
          bottom: 0.23,
        },
      },
      timeScale: {
        visible: true,
        borderColor: "#242b36",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7,
        minBarSpacing: 1.5,
        fixLeftEdge: false,
        fixRightEdge: false,
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
      scaleMargins: {
        top: 0.80,
        bottom: 0,
      },
    });

    state.chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) {
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

    const resizeChart = () => {
      if (!state.chart || !container.isConnected) return;

      const width = Math.max(container.clientWidth, 320);
      const height = Math.max(container.clientHeight, 320);
      state.chart.resize(width, height);
    };

    state.chartResizeObserver?.disconnect?.();
    state.chartResizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(resizeChart);
    });
    state.chartResizeObserver.observe(container);

    window.addEventListener("resize", resizeChart);
  }

  const candleData = rows.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
  }));

  const volumeData = rows.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    value: Number(row[5]),
    color:
      Number(row[4]) >= Number(row[1])
        ? "rgba(32,201,135,.52)"
        : "rgba(255,95,120,.52)",
  }));

  state.candleSeries.setData(candleData);
  state.volumeSeries.setData(volumeData);
  updateChartOhlc(rows.at(-1));

  requestAnimationFrame(() => {
    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 320);
    state.chart.resize(width, height);
    state.chart.timeScale().fitContent();
  });
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
  if (!depth || !Array.isArray(depth.asks) || !Array.isArray(depth.bids)) {
    throw new Error("Некорректные данные стакана");
  }

  const precision = Number($("orderbookPrecision")?.value) || .1;

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

  const visibleOrderbookRows = window.matchMedia("(max-width: 760px)").matches ? 5 : 8;
  const asks = prepareRows([...depth.asks].reverse().slice(0, visibleOrderbookRows));
  const bids = prepareRows(depth.bids.slice(0, visibleOrderbookRows));

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
  if (!state.chart) {
    loadTradingTerminal();
    return;
  }

  state.chart.timeScale().fitContent();
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


function assertAdmin(){if(userProfile.role!=="admin")throw new Error("Недостаточно прав администратора");}
async function loadAdminPanel(search=""){
 assertAdmin(); $("adminUsersList").innerHTML='<div class="admin-empty">Загрузка…</div>'; $("adminFundingList").innerHTML='<div class="admin-empty">Загрузка…</div>';
 try{const [o,u,f]=await Promise.all([supabaseClient.rpc("admin_platform_overview"),supabaseClient.rpc("admin_list_users",{p_search:search||null,p_limit:100,p_offset:0}),supabaseClient.rpc("admin_list_funding_requests",{p_status:"pending",p_limit:100})]); if(o.error)throw o.error;if(u.error)throw u.error;if(f.error)throw f.error; state.adminOverview=o.data?.[0]||o.data||{};state.adminUsers=u.data||[];state.adminFundingRequests=f.data||[];renderAdminOverview();renderAdminUsers();renderAdminFunding();}catch(e){console.error(e);showToast(e.message||"Ошибка Admin Panel");}
}
function renderAdminOverview(){const d=state.adminOverview||{};$("adminUsersCount").textContent=Number(d.users_count||0).toLocaleString("ru-RU");$("adminTotalBalance").textContent=`${Number(d.total_platform_balance||0).toFixed(2)} USDT`;$("adminPendingCount").textContent=Number(d.pending_requests_count||0);$("adminAdminsCount").textContent=Number(d.admins_count||0);}
function renderAdminUsers(){const r=state.adminUsers;$("adminUsersList").innerHTML=r.length?r.map(u=>`<div class="admin-user-row"><div class="admin-user-identity"><strong>${escapeHtml(u.username||"User")}</strong><span>${escapeHtml(u.email||"")}</span><small>${escapeHtml(u.fastboot_id||"")}</small></div><span class="admin-role-badge ${u.role==="admin"?"admin":""}">${escapeHtml(u.role||"user")}</span><strong>${Number(u.spot_balance||0).toFixed(2)}</strong><strong>${Number(u.bot_balance||0).toFixed(2)}</strong><span>${formatDateTime(u.created_at)}</span><div class="admin-row-actions"><button class="secondary-action compact" data-admin-balance="${u.id}">Баланс</button><button class="secondary-action compact" data-admin-role="${u.id}">Роль</button></div></div>`).join(""):'<div class="admin-empty">Пользователи не найдены</div>';document.querySelectorAll("[data-admin-balance]").forEach(b=>b.onclick=()=>openAdminBalanceModal(r.find(x=>x.id===b.dataset.adminBalance)));document.querySelectorAll("[data-admin-role]").forEach(b=>b.onclick=()=>openAdminRoleModal(r.find(x=>x.id===b.dataset.adminRole)));}
function renderAdminFunding(){
  const a=state.adminFundingRequests;

  $("adminFundingList").innerHTML=a.length
    ?a.map(x=>{
      const txLink=x.txid
        ?`https://tronscan.org/#/transaction/${encodeURIComponent(x.txid)}`
        :null;

      return `<article class="admin-funding-item">
        <div class="admin-funding-main">
          <span class="admin-funding-type ${x.type}">
            ${x.type==="deposit"?"Пополнение":"Вывод"}
          </span>
          <strong>${Number(x.amount).toFixed(2)} ${escapeHtml(x.asset||"USDT")}</strong>
          <span>${escapeHtml(x.username||x.email||"")}</span>
          <small>${escapeHtml(x.fastboot_id||"")}</small>
          <small>${formatDateTime(x.created_at)}</small>

          <div class="admin-funding-meta">
            <span>Сеть: <strong>${escapeHtml(x.network||"TRC20")}</strong></span>
            ${x.wallet_address
              ?`<span>Адрес: <code>${escapeHtml(x.wallet_address)}</code></span>`
              :""}
            ${x.txid
              ?`<span>TXID: <code>${escapeHtml(x.txid)}</code></span>`
              :""}
          </div>

          ${txLink
            ?`<a class="tronscan-link" href="${txLink}" target="_blank" rel="noopener">
                Проверить TXID в Tronscan
              </a>`
            :""}
        </div>

        <div class="admin-funding-actions">
          <button class="primary-action compact"
            data-fa="approve" data-fid="${x.id}">Одобрить</button>
          <button class="danger-action compact"
            data-fa="reject" data-fid="${x.id}">Отклонить</button>
        </div>
      </article>`;
    }).join("")
    :'<div class="admin-empty">Ожидающих заявок нет</div>';

  document.querySelectorAll("[data-fa]").forEach(
    b=>b.onclick=()=>processAdminFunding(b.dataset.fid,b.dataset.fa)
  );
}
function openAdminBalanceModal(u){if(!u)return;$("adminModalTitle").textContent="Изменение баланса";$("adminModalBody").innerHTML=`<div class="admin-modal-user"><strong>${escapeHtml(u.username||"User")}</strong><span>${escapeHtml(u.email||"")}</span></div><div class="modal-form"><label>Счёт<select id="adminWalletType"><option value="spot">Основной</option><option value="bot">AI Bot</option></select></label><label>Операция<select id="adminBalanceOperation"><option value="credit">Начислить</option><option value="debit">Списать</option></select></label><label>Сумма USDT<input id="adminBalanceAmount" type="number" min="0.01" step="0.01"></label><label>Причина<input id="adminBalanceReason" maxlength="300"></label><button id="confirmAdminBalanceButton" class="primary-action">Применить</button></div>`;$("adminModal").classList.remove("hidden");$("confirmAdminBalanceButton").onclick=async()=>{const amount=Number($("adminBalanceAmount").value);if(!(amount>0))return showToast("Введите сумму");try{const {error}=await supabaseClient.rpc("admin_adjust_user_balance",{p_user_id:u.id,p_wallet:$("adminWalletType").value,p_operation:$("adminBalanceOperation").value,p_amount:amount,p_reason:$("adminBalanceReason").value.trim()||null});if(error)throw error;$("adminModal").classList.add("hidden");showToast("Баланс обновлён");await loadAdminPanel($("adminUserSearch").value.trim());}catch(e){showToast(e.message||"Ошибка");}};}
function openAdminRoleModal(u){if(!u)return;$("adminModalTitle").textContent="Изменение роли";$("adminModalBody").innerHTML=`<div class="admin-modal-user"><strong>${escapeHtml(u.username||"User")}</strong><span>${escapeHtml(u.email||"")}</span></div><div class="modal-form"><label>Роль<select id="adminNewRole"><option value="user" ${u.role==="user"?"selected":""}>user</option><option value="admin" ${u.role==="admin"?"selected":""}>admin</option></select></label><button id="confirmAdminRoleButton" class="primary-action">Сохранить</button></div>`;$("adminModal").classList.remove("hidden");$("confirmAdminRoleButton").onclick=async()=>{try{const {error}=await supabaseClient.rpc("admin_set_user_role",{p_user_id:u.id,p_role:$("adminNewRole").value});if(error)throw error;$("adminModal").classList.add("hidden");showToast("Роль изменена");await loadAdminPanel($("adminUserSearch").value.trim());}catch(e){showToast(e.message||"Ошибка");}};}
async function processAdminFunding(id,action){if(!confirm(action==="approve"?"Одобрить заявку?":"Отклонить заявку?"))return;try{const {error}=await supabaseClient.rpc("admin_process_funding_request",{p_request_id:id,p_action:action,p_note:null});if(error)throw error;showToast(action==="approve"?"Заявка одобрена":"Заявка отклонена");await loadAdminPanel($("adminUserSearch").value.trim());}catch(e){showToast(e.message||"Ошибка");}}
$("adminRefreshButton")?.addEventListener("click",()=>loadAdminPanel($("adminUserSearch").value.trim()));$("adminSearchButton")?.addEventListener("click",()=>loadAdminPanel($("adminUserSearch").value.trim()));$("adminUserSearch")?.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();loadAdminPanel(e.target.value.trim());}});$("closeAdminModalButton")?.addEventListener("click",()=>$("adminModal").classList.add("hidden"));

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

$("saveProfileButton").addEventListener("click", async () => {
  const name = $("settingsName").value.trim();

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) {
    showToast("Имя: 3–24 латинские буквы, цифры или _");
    return;
  }

  $("saveProfileButton").disabled = true;

  try {
    const { data, error } = await supabaseClient
      .from("profiles")
      .update({ username: name })
      .eq("id", authUser.id)
      .select("username")
      .single();

    if (error) throw error;

    userProfile.username = data.username;
    initializeUser();
    showToast("Профиль обновлён");
  } catch (error) {
    console.error("Ошибка обновления профиля:", error);
    showToast(
      error?.code === "23505"
        ? "Такое имя пользователя уже занято"
        : "Не удалось обновить профиль"
    );
  } finally {
    $("saveProfileButton").disabled = false;
  }
});

const restoredSection = localStorage.getItem("fastboot-active-section") || "overview";
document.documentElement.style.overflow = "";
document.body.style.overflow = "";
document.body.classList.remove("mobile-bottom-drawer-open");
initializeUser();
applySupabaseWalletToPortfolio();
renderOrders();
renderJournal();

loadSupabaseAccountData()
  .catch((error) => {
    console.error("Ошибка загрузки аккаунта:", error);
    showToast("Не удалось загрузить данные аккаунта");
    renderAccount();
  })
  .finally(() => {
    loadPrices();
  });

openSection(titles[restoredSection] ? restoredSection : "overview");


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






document.querySelectorAll("[data-mobile-bottom]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-mobile-bottom]").forEach((item) =>
      item.classList.toggle("active", item === button)
    );

    const target = button.dataset.mobileBottom;
    document.querySelector(`[data-bottom-tab="${target}"]`)?.click();
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


$("mobileTradingHomeButton")?.addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
});


function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


let terminalViewportMode = window.matchMedia("(max-width: 760px)").matches;
window.addEventListener("resize", () => {
  const nextMode = window.matchMedia("(max-width: 760px)").matches;
  if (nextMode !== terminalViewportMode) {
    terminalViewportMode = nextMode;
    if (state.section === "trading") {
      loadTradingTerminal();
    }
  }
});


document.querySelectorAll("[data-mobile-bottom]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;

    document.querySelectorAll("[data-mobile-bottom]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
  });
});


async function openMobileChart() {
  if (!window.matchMedia("(max-width: 760px)").matches) return;

  $("mobileChartSymbol").textContent = state.currentSymbol;
  $("mobileChartModal").classList.remove("hidden");

  await loadMobileChartData();
}

function closeMobileChart() {
  $("mobileChartModal").classList.add("hidden");
}

async function loadMobileChartData() {
  const container = $("mobileChartContainer");
  if (!container) return;

  try {
    const rows = await fetchJson(
      `${REST_BASE}/api/v3/klines?symbol=${state.currentSymbol}` +
      `&interval=${state.mobileChartInterval}&limit=300`
    );

    if (!state.mobileChart) {
      state.mobileChart = LightweightCharts.createChart(container, {
        width: Math.max(container.clientWidth, 320),
        height: Math.max(container.clientHeight, 360),
        layout: {
          background: { type: "solid", color: "#101620" },
          textColor: "#8793a5",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(135,147,165,.10)" },
          horzLines: { color: "rgba(135,147,165,.10)" },
        },
        rightPriceScale: {
          borderColor: "#2c3544",
          scaleMargins: { top: .07, bottom: .22 },
        },
        timeScale: {
          borderColor: "#2c3544",
          timeVisible: true,
          secondsVisible: false,
        },
      });

      state.mobileChartSeries = state.mobileChart.addSeries(
        LightweightCharts.CandlestickSeries,
        {
          upColor: "#20c987",
          downColor: "#ff5f78",
          borderVisible: false,
          wickUpColor: "#20c987",
          wickDownColor: "#ff5f78",
        }
      );

      state.mobileChartVolumeSeries = state.mobileChart.addSeries(
        LightweightCharts.HistogramSeries,
        {
          priceFormat: { type: "volume" },
          priceScaleId: "mobile-volume",
          priceLineVisible: false,
          lastValueVisible: false,
        }
      );

      state.mobileChartVolumeSeries.priceScale().applyOptions({
        scaleMargins: { top: .82, bottom: 0 },
      });

      new ResizeObserver(() => {
        if (!state.mobileChart || $("mobileChartModal").classList.contains("hidden")) {
          return;
        }

        state.mobileChart.resize(
          Math.max(container.clientWidth, 320),
          Math.max(container.clientHeight, 360)
        );
      }).observe(container);
    }

    state.mobileChartSeries.setData(
      rows.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
      }))
    );

    state.mobileChartVolumeSeries.setData(
      rows.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        value: Number(row[5]),
        color:
          Number(row[4]) >= Number(row[1])
            ? "rgba(32,201,135,.50)"
            : "rgba(255,95,120,.50)",
      }))
    );

    requestAnimationFrame(() => {
      state.mobileChart.resize(
        Math.max(container.clientWidth, 320),
        Math.max(container.clientHeight, 360)
      );
      state.mobileChart.timeScale().fitContent();
    });
  } catch (error) {
    console.error("Ошибка мобильного графика:", error);
    showToast("Не удалось открыть график");
  }
}

$("mobileChartButton")?.addEventListener("click", openMobileChart);
$("closeMobileChartButton")?.addEventListener("click", closeMobileChart);

document.querySelectorAll("[data-mobile-chart-interval]").forEach((button) => {
  button.addEventListener("click", async () => {
    document.querySelectorAll("[data-mobile-chart-interval]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    state.mobileChartInterval = button.dataset.mobileChartInterval;
    await loadMobileChartData();
  });
});


function closeMobileBottomDrawer() {
  document.body.classList.remove("mobile-bottom-drawer-open");
}

function openMobileBottomDrawer(tabName, clickedButton) {
  const targetMap = {
    "open-orders": "openOrdersContent",
    positions: "positionsContent",
  };

  const targetId = targetMap[tabName];
  if (!targetId) return;

  const isAlreadyOpen =
    document.body.classList.contains("mobile-bottom-drawer-open") &&
    clickedButton.classList.contains("active");

  document.querySelectorAll("[data-mobile-bottom]").forEach((item) => {
    item.classList.toggle("active", item === clickedButton);
  });

  document.querySelectorAll(".terminal-bottom-content").forEach((content) => {
    content.classList.toggle("active", content.id === targetId);
  });

  if (isAlreadyOpen) {
    closeMobileBottomDrawer();
    return;
  }

  document.body.classList.add("mobile-bottom-drawer-open");
}

document.querySelectorAll("[data-mobile-bottom]").forEach((button) => {
  button.addEventListener("click", (event) => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openMobileBottomDrawer(button.dataset.mobileBottom, button);
  }, true);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMobileBottomDrawer();
  }
});
