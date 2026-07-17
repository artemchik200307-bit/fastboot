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
  operationFilter: "all",
  aiBotAccount: null,
  aiTradeResults: [],
  adminAiOpenTrades: [],
  adminBotStatuses: [],
  terminalJournalTrades: [],
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
  terminalResizeObserver: null,
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
  trading: "Торговый терминал",
  "market-analysis": "Анализ рынка",
  admin: "Admin Panel",
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

  document.body.classList.remove("mobile-bottom-drawer-open");
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
  document.body.classList.remove("trading-mode");
  document.querySelectorAll(".dashboard-section").forEach((el) => el.classList.toggle("active", el.id === id));
  document.querySelectorAll(".nav-item[data-section]").forEach((el) => el.classList.toggle("active", el.dataset.section === id));
  $("pageTitle").textContent = titles[id] || "FASTBOOT";
  $("sidebar").classList.remove("open");
  document.body.classList.remove("trading-mode");
  document.body.classList.toggle("trading-mode", id === "trading");

  if (id === "trading") {
    const terminalFrame = $("terminalFrame");

    if (terminalFrame?.contentWindow) {
      terminalFrame.contentWindow.postMessage(
        { type: "FASTBOOT_TERMINAL_REFRESH" },
        window.location.origin
      );
    }
  }

  if (id === "market-analysis") loadMarketAnalysis();

  if (id === "admin") {
    if (String(userProfile.role || "").toLowerCase() !== "admin") {
      showToast("Нет доступа");
      openSection("overview");
      return;
    }

    loadAdminPanel();
  }
  const dashboardScroller = document.querySelector(".dashboard-main");

  if (dashboardScroller) {
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

  $("detailUsername").textContent = username;
  $("detailEmail").textContent = email;
  $("detailFastbootId").textContent = publicId;
  $("detailRole").textContent = userProfile.role || "user";
  $("detailCreatedAt").textContent = formatDateTime(
    userProfile.created_at || authUser.created_at
  );
  const isAdmin = String(userProfile.role || "").toLowerCase() === "admin";
  $("adminNavButton")?.classList.toggle("hidden", !isAdmin);
  document.documentElement.classList.toggle("is-admin", isAdmin);
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
      .maybeSingle(),

    supabaseClient
      .from("funding_requests")
      .select("id, type, amount, asset, network, txid, wallet_address, status, details, created_at")
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

  if (walletResult.error) console.error("Wallet load error:", walletResult.error);
  if (fundingResult.error) console.error("Funding load error:", fundingResult.error);
  if (transactionResult.error) console.error("Transaction load error:", transactionResult.error);
  if (transferResult.error) console.error("Transfer load error:", transferResult.error);

  Object.assign(
    userWallet,
    walletResult.data ||
      window.fastbootWallet || {
        user_id: authUser.id,
        spot_balance: 0,
        bot_balance: 0,
        currency: "USDT",
      }
  );

  state.deposits = (fundingResult.data || []).filter(
    (item) => item.type === "deposit"
  );
  state.withdrawals = (fundingResult.data || []).filter(
    (item) => item.type === "withdraw"
  );
  state.fundingRequests = fundingResult.data || [];
  state.transactions = transactionResult.data || [];
  state.transfers = transferResult.data || [];

  try {
    const [botAccountResult, aiResultsResult] = await Promise.all([
      supabaseClient
        .from("ai_bot_accounts")
        .select("user_id, is_active, started_at, stopped_at, initial_balance, created_at, updated_at")
        .eq("user_id", authUser.id)
        .maybeSingle(),

      supabaseClient
        .from("user_ai_trade_results")
        .select("id, pair, side, entry_price, exit_price, opened_at, closed_at, pnl_percent, balance_before, pnl_amount, balance_after, created_at")
        .eq("user_id", authUser.id)
        .order("closed_at", { ascending: false })
        .limit(200),
    ]);

    if (botAccountResult.error) console.warn("AI account unavailable:", botAccountResult.error);
    if (aiResultsResult.error) console.warn("AI history unavailable:", aiResultsResult.error);

    state.aiBotAccount = botAccountResult.data || null;
    state.aiTradeResults = aiResultsResult.data || [];
  } catch (error) {
    console.warn("AI data load skipped:", error);
    state.aiBotAccount = null;
    state.aiTradeResults = [];
  }

  initializeUser();
  applySupabaseWalletToPortfolio();
  renderAccount();
  renderAiAssistant();
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

  $("spotBalanceCard").textContent = `${spotBalance.toFixed(2)} USDT`;
  $("botBalanceCard").textContent = `${botBalance.toFixed(2)} USDT`;

  const pendingDeposits = state.deposits.filter(
    (item) => item.status === "pending"
  );
  const pendingWithdrawals = state.withdrawals.filter(
    (item) => item.status === "pending"
  );

  const pendingDepositAmount = pendingDeposits.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );
  const pendingWithdrawAmount = pendingWithdrawals.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );

  $("pendingDepositCard").textContent =
    `${pendingDepositAmount.toFixed(2)} USDT`;
  $("pendingWithdrawCard").textContent =
    `${pendingWithdrawAmount.toFixed(2)} USDT`;
  $("pendingDepositCount").textContent =
    `${pendingDeposits.length} заявок`;
  $("pendingWithdrawCount").textContent =
    `${pendingWithdrawals.length} заявок`;

  $("detailUpdatedAt").textContent = formatDateTime(
    userWallet?.updated_at || new Date().toISOString()
  );

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
  renderCompleteOperationHistory();
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

function setModalOpenState(isOpen) {
  document.body.classList.toggle("modal-open", Boolean(isOpen));
}

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
  setModalOpenState(true);
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
    setModalOpenState(false);
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
$("closeModalButton").addEventListener("click", () => {
  $("actionModal").classList.add("hidden");
  setModalOpenState(false);
});


function getCombinedOperations() {
  const funding = state.fundingRequests.map((item) => ({
    id: item.id,
    category: item.type,
    type: item.type,
    amount: Number(item.amount || 0),
    asset: item.asset || "USDT",
    status: item.status,
    created_at: item.created_at,
    network: item.network || "TRC20",
    txid: item.txid || null,
    wallet_address: item.wallet_address || null,
    description:
      item.type === "deposit"
        ? "Пополнение основного счёта"
        : "Вывод с основного счёта",
  }));

  const transfers = state.transfers.map((item) => ({
    id: item.id,
    category: "transfer",
    type: item.to_wallet === "bot"
      ? "transfer_to_bot"
      : "transfer_to_spot",
    amount: Number(item.amount || 0),
    asset: "USDT",
    status: "completed",
    created_at: item.created_at,
    description: item.to_wallet === "bot"
      ? "Перевод на счёт AI-бота"
      : "Перевод на основной счёт",
  }));

  return [...funding, ...transfers].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
}

function operationTitle(item) {
  const map = {
    deposit: "Пополнение",
    withdraw: "Вывод",
    transfer_to_bot: "Перевод на AI Bot",
    transfer_to_spot: "Перевод на основной счёт",
  };

  return map[item.type] || item.description || item.type;
}

function operationSign(item) {
  if (item.type === "deposit" || item.type === "transfer_to_spot") {
    return "+";
  }

  return "−";
}

function renderCompleteOperationHistory() {
  const filter = state.operationFilter;
  const operations = getCombinedOperations().filter((item) => {
    if (filter === "all") return true;
    return item.category === filter;
  });

  $("completeOperationHistory").innerHTML = operations.length
    ? operations.slice(0, 50).map((item) => {
      const txUrl = item.txid
        ? `https://tronscan.org/#/transaction/${encodeURIComponent(item.txid)}`
        : null;

      return `
        <article class="complete-operation-row">
          <div class="operation-symbol ${item.category}">
            ${item.category === "deposit"
              ? "↓"
              : item.category === "withdraw"
                ? "↑"
                : "⇄"}
          </div>

          <div class="operation-main-copy">
            <strong>${escapeHtml(operationTitle(item))}</strong>
            <span>${formatDateTime(item.created_at)}</span>
            ${item.network
              ? `<small>${escapeHtml(item.asset)} · ${escapeHtml(item.network)}</small>`
              : ""}
          </div>

          <div class="operation-extra-copy">
            ${item.wallet_address
              ? `<span>Адрес: ${escapeHtml(item.wallet_address)}</span>`
              : ""}
            ${txUrl
              ? `<a href="${txUrl}" target="_blank" rel="noopener">Открыть TXID</a>`
              : ""}
          </div>

          <div class="operation-amount-copy">
            <strong class="${operationSign(item) === "+" ? "positive" : "negative"}">
              ${operationSign(item)}${Number(item.amount).toFixed(2)} ${escapeHtml(item.asset)}
            </strong>
            <span class="status-pill status-${escapeHtml(item.status || "completed")}">
              ${escapeHtml(formatOperationStatus(item.status))}
            </span>
          </div>
        </article>
      `;
    }).join("")
    : '<div class="empty-list">Операций по выбранному фильтру нет</div>';
}

document.querySelectorAll("[data-operation-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.operationFilter = button.dataset.operationFilter;

    document.querySelectorAll("[data-operation-filter]").forEach((item) => {
      item.classList.toggle(
        "active",
        item.dataset.operationFilter === state.operationFilter
      );
    });

    renderCompleteOperationHistory();
  });
});



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




function safeFormatPrice(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) return "—";

  if (Math.abs(number) >= 1000) {
    return number.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (Math.abs(number) >= 1) {
    return number.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }

  return number.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 8,
  });
}

function assertAdmin(){if(userProfile.role!=="admin")throw new Error("Недостаточно прав администратора");}
async function loadAdminPanel(search = "") {
  assertAdmin();

  $("adminUsersList").innerHTML =
    '<div class="admin-empty">Загрузка…</div>';

  $("adminFundingList").innerHTML =
    '<div class="admin-empty">Загрузка…</div>';

  try {
    const [overview, users, funding, botStatuses] =
      await Promise.all([
        supabaseClient.rpc("admin_platform_overview"),
        supabaseClient.rpc("admin_list_users", {
          p_search: search || null,
          p_limit: 100,
          p_offset: 0,
        }),
        supabaseClient.rpc("admin_list_funding_requests", {
          p_status: "pending",
          p_limit: 100,
        }),
        supabaseClient.rpc("admin_list_ai_bot_statuses", {
          p_search: search || null,
        }),
      ]);

    if (overview.error) throw overview.error;
    if (users.error) throw users.error;
    if (funding.error) throw funding.error;
    if (botStatuses.error) throw botStatuses.error;

    state.adminOverview =
      overview.data?.[0] || overview.data || {};

    state.adminUsers = users.data || [];
    state.adminFundingRequests = funding.data || [];
    state.adminBotStatuses = botStatuses.data || [];

    const botMap = new Map(
      state.adminBotStatuses.map((item) => [
        item.user_id,
        Boolean(item.is_active),
      ])
    );

    state.adminUsers = state.adminUsers.map((user) => ({
      ...user,
      ai_bot_active: botMap.get(user.id) || false,
    }));

    renderAdminOverview();
    renderAdminUsers();
    renderAdminFunding();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Ошибка Admin Panel");
  }
}

function renderAdminOverview(){const d=state.adminOverview||{};$("adminUsersCount").textContent=Number(d.users_count||0).toLocaleString("ru-RU");$("adminTotalBalance").textContent=`${Number(d.total_platform_balance||0).toFixed(2)} USDT`;$("adminPendingCount").textContent=Number(d.pending_requests_count||0);$("adminAdminsCount").textContent=Number(d.admins_count||0);}
function renderAdminUsers() {
  const users = state.adminUsers;

  $("adminUsersList").innerHTML = users.length
    ? users.map((user) => `
      <div class="admin-user-row">
        <div class="admin-user-identity">
          <strong>${escapeHtml(user.username || "User")}</strong>
          <span>${escapeHtml(user.email || "")}</span>
          <small>${escapeHtml(user.fastboot_id || "")}</small>
        </div>

        <span class="admin-role-badge ${
          user.role === "admin" ? "admin" : ""
        }">
          ${escapeHtml(user.role || "user")}
        </span>

        <span class="admin-bot-status ${
          user.ai_bot_active ? "active" : "inactive"
        }">
          <i></i>
          ${user.ai_bot_active ? "AI включён" : "AI выключен"}
        </span>

        <strong>${Number(user.spot_balance || 0).toFixed(2)}</strong>
        <strong>${Number(user.bot_balance || 0).toFixed(2)}</strong>
        <span>${formatDateTime(user.created_at)}</span>

        <div class="admin-row-actions">
          <button class="secondary-action compact"
            data-admin-balance="${user.id}">Баланс</button>
          <button class="secondary-action compact"
            data-admin-role="${user.id}">Роль</button>
        </div>
      </div>
    `).join("")
    : '<div class="admin-empty">Пользователи не найдены</div>';

  document.querySelectorAll("[data-admin-balance]").forEach((button) => {
    button.onclick = () =>
      openAdminBalanceModal(
        users.find((item) => item.id === button.dataset.adminBalance)
      );
  });

  document.querySelectorAll("[data-admin-role]").forEach((button) => {
    button.onclick = () =>
      openAdminRoleModal(
        users.find((item) => item.id === button.dataset.adminRole)
      );
  });
}

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


function aiClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function aiPeriod(days) {
  const from = Date.now() - days * 86400000;
  const rows = state.aiTradeResults.filter(
    (item) => new Date(item.closed_at).getTime() >= from
  );

  return {
    percent: rows.reduce((sum, item) => sum + Number(item.pnl_percent || 0), 0),
    amount: rows.reduce((sum, item) => sum + Number(item.pnl_amount || 0), 0),
  };
}

function renderAiAssistant() {
  const spot = Number(userWallet?.spot_balance || 0);
  const bot = Number(userWallet?.bot_balance || 0);
  const active = Boolean(state.aiBotAccount?.is_active);
  const initial = Number(state.aiBotAccount?.initial_balance || bot || 0);

  const totalPnl = state.aiTradeResults.reduce(
    (sum, item) => sum + Number(item.pnl_amount || 0),
    0
  );
  const totalPercent = initial > 0 ? (totalPnl / initial) * 100 : 0;

  $("botBalance").textContent = `${bot.toFixed(2)} USDT`;
  $("aiSpotBalance").textContent = `${spot.toFixed(2)} USDT`;
  $("aiBotBalanceSmall").textContent = `${bot.toFixed(2)} USDT`;
  $("aiInitialBalance").textContent = `${initial.toFixed(2)} USDT`;

  $("aiTotalPnl").textContent =
    `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`;
  $("aiTotalPnl").className = aiClass(totalPnl);

  $("aiReturnBadge").textContent =
    `${totalPercent >= 0 ? "+" : ""}${totalPercent.toFixed(2)}%`;
  $("aiReturnBadge").className = `ai-return-badge ${aiClass(totalPercent)}`;

  $("botStatus").textContent = active ? "Активен" : "Остановлен";
  $("aiStatusDot").classList.toggle("active", active);
  $("startBotButton").disabled = active;
  $("stopBotButton").disabled = !active;

  const day = aiPeriod(1);
  const week = aiPeriod(7);
  const month = aiPeriod(30);

  [
    ["botDayPnl", "botDayAmount", day],
    ["botWeekPnl", "botWeekAmount", week],
    ["botMonthPnl", "botMonthAmount", month],
  ].forEach(([pId, aId, data]) => {
    $(pId).textContent =
      `${data.percent >= 0 ? "+" : ""}${data.percent.toFixed(2)}%`;
    $(pId).className = aiClass(data.percent);

    $(aId).textContent =
      `${data.amount >= 0 ? "+" : ""}${data.amount.toFixed(2)} USDT`;
  });

  const wins = state.aiTradeResults.filter(
    (item) => Number(item.pnl_percent) > 0
  ).length;
  const winRate = state.aiTradeResults.length
    ? (wins / state.aiTradeResults.length) * 100
    : 0;

  $("botTradesCount").textContent = state.aiTradeResults.length;
  $("botWinRate").textContent = `Win rate ${winRate.toFixed(0)}%`;

  renderAiHistory();
  renderAiEquity();
}

function renderAiHistory() {
  $("botHistory").innerHTML = state.aiTradeResults.length
    ? state.aiTradeResults.map((trade) => `
      <div class="ai-history-row">
        <strong>${escapeHtml(trade.pair)}</strong>
        <span class="ai-side-badge ${trade.side.toLowerCase()}">${escapeHtml(trade.side)}</span>
        <span>${formatDateTime(trade.opened_at)}</span>
        <span>${formatDateTime(trade.closed_at)}</span>
        <span class="ai-price-pair">
          ${safeFormatPrice(Number(trade.entry_price))}
          <small>→</small>
          ${safeFormatPrice(Number(trade.exit_price))}
        </span>
        <div class="ai-result-cell">
          <strong class="${aiClass(trade.pnl_percent)}">
            ${Number(trade.pnl_percent) >= 0 ? "+" : ""}${Number(trade.pnl_percent).toFixed(2)}%
          </strong>
          <span class="${aiClass(trade.pnl_amount)}">
            ${Number(trade.pnl_amount) >= 0 ? "+" : ""}${Number(trade.pnl_amount).toFixed(2)} USDT
          </span>
        </div>
      </div>
    `).join("")
    : '<div class="admin-empty">История сделок пока пуста</div>';
}

function renderAiEquity() {
  const container = $("aiEquityChart");
  const rows = [...state.aiTradeResults].reverse();

  if (!rows.length) {
    container.innerHTML =
      '<div class="admin-empty">График появится после первой сделки</div>';
    return;
  }

  const values = rows.map((item) => Number(item.balance_after));
  const width = 620;
  const height = 180;
  const pad = 18;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);

  const points = values.map((value, index) => {
    const x = pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <polyline class="ai-equity-line" points="${points}"></polyline>
    </svg>
    <div class="ai-equity-range">
      <span>${min.toFixed(2)} USDT</span>
      <strong>${values.at(-1).toFixed(2)} USDT</strong>
      <span>${max.toFixed(2)} USDT</span>
    </div>
  `;
}

async function setAiBotStatus(active) {
  if (active && Number(userWallet?.bot_balance || 0) < 50) {
    showToast(
      `Для запуска AI Assistant нужно минимум 50 USDT. ` +
      `Сейчас на AI-счёте: ${Number(userWallet?.bot_balance || 0).toFixed(2)} USDT`
    );
    return;
  }

  const button = active ? $("startBotButton") : $("stopBotButton");
  button.disabled = true;

  try {
    const { error } = await supabaseClient.rpc(
      "set_ai_bot_status",
      { p_active: active }
    );

    if (error) throw error;

    showToast(active ? "AI Assistant запущен" : "AI Assistant остановлен");
    await loadSupabaseAccountData();
  } catch (error) {
    console.error(error);
    showToast(error?.message || "Не удалось изменить статус");
  } finally {
    button.disabled = false;
  }
}

$("startBotButton").addEventListener("click", () => setAiBotStatus(true));
$("stopBotButton").addEventListener("click", () => setAiBotStatus(false));

function localDateValue(date = new Date()) {
  const offset = date.getTimezoneOffset();

  return new Date(date.getTime() - offset * 60000)
    .toISOString()
    .slice(0, 10);
}

if ($("adminAiTradeDate")) {
  $("adminAiTradeDate").value = localDateValue();
}

$("adminAiCompletedTradeForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const pair = $("adminAiPair").value.trim().toUpperCase();
  const side = $("adminAiSide").value;
  const entryPrice = Number($("adminAiEntryPrice").value);
  const exitPrice = Number($("adminAiExitPrice").value);
  const tradeDate = $("adminAiTradeDate").value;
  const pnlPercent = Number($("adminAiPnlPercent").value);

  if (!/^[A-Z0-9]{5,20}$/.test(pair)) {
    showToast("Введите корректную торговую пару");
    return;
  }

  if (!(entryPrice > 0) || !(exitPrice > 0)) {
    showToast("Введите цены открытия и закрытия");
    return;
  }

  if (!tradeDate) {
    showToast("Выберите дату сделки");
    return;
  }

  if (!Number.isFinite(pnlPercent) || pnlPercent < -100 || pnlPercent > 100) {
    showToast("Введите корректный результат в процентах");
    return;
  }

  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;

  try {
    const { error } = await supabaseClient.rpc(
      "admin_publish_ai_trade",
      {
        p_pair: pair,
        p_side: side,
        p_entry_price: entryPrice,
        p_exit_price: exitPrice,
        p_trade_date: tradeDate,
        p_pnl_percent: pnlPercent,
      }
    );

    if (error) throw error;

    event.target.reset();
    $("adminAiSide").value = "LONG";
    $("adminAiTradeDate").value = localDateValue();

    showToast("Сделка добавлена. История AI Assistant обновляется…");

    await loadSupabaseAccountData();

    if (String(userProfile.role || "").toLowerCase() === "admin") {
      await loadAdminPanel($("adminUserSearch")?.value.trim() || "");
    }

    renderAiAssistant();
    showToast("Сделка добавлена в историю AI Assistant");
  } catch (error) {
    console.error("Ошибка публикации AI-сделки:", error);
    showToast(error?.message || "Не удалось добавить сделку");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
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

async function loadTerminalJournalTrades() {
  try {
    const { data, error } = await supabaseClient
      .from("terminal_trades")
      .select("*")
      .eq("user_id", authUser.id)
      .order("closed_at", { ascending: false })
      .limit(200);

    if (error) throw error;
    state.terminalJournalTrades = data || [];
  } catch (error) {
    console.error("Terminal journal load error:", error);
    state.terminalJournalTrades = [];
  }
}

async function renderJournal() {
  await loadTerminalJournalTrades();

  const localOrders = state.orders.map((order) => ({
    date: order.date,
    symbol: order.symbol,
    type: order.type,
    side: order.side,
    price: order.price,
    amount: order.amount,
    total: Number(order.total || 0),
    pnl: null,
    source: "Локальная сделка",
  }));

  const terminalTrades = state.terminalJournalTrades.map((trade) => ({
    date: formatDateTime(trade.closed_at),
    symbol: trade.symbol,
    type: "MARKET",
    side: trade.side === "LONG" ? "BUY" : "SELL",
    price: Number(trade.exit_price),
    amount: formatQuantity(trade.quantity),
    total: Number(trade.exit_price) * Number(trade.quantity),
    pnl: Number(trade.pnl || 0),
    source: "Терминал",
  }));

  const rows = [...terminalTrades, ...localOrders];

  $("journalOrdersCount").textContent = rows.length;
  $("journalBuyCount").textContent =
    rows.filter((item) => item.side === "BUY").length;

  $("journalSellCount").textContent =
    rows.filter((item) => item.side === "SELL").length;

  $("journalTurnover").textContent =
    `${rows.reduce((sum, item) => sum + item.total, 0).toFixed(2)} USDT`;

  $("journalOrders").innerHTML = rows.length
    ? rows.map((item) => `
      <div class="order-history-row terminal-journal-row">
        <span>${escapeHtml(item.date)}</span>
        <strong>${escapeHtml(item.symbol)}</strong>
        <span>${escapeHtml(item.type)}</span>
        <span class="${item.side === "BUY" ? "positive" : "negative"}">
          ${escapeHtml(item.side)}
        </span>
        <span>${safeFormatPrice(item.price)}</span>
        <span>${escapeHtml(item.amount)}</span>
        <span>${item.total.toFixed(2)}</span>
        <span class="${
          item.pnl === null
            ? ""
            : item.pnl >= 0
              ? "positive"
              : "negative"
        }">
          ${item.pnl === null
            ? item.source
            : `${item.pnl >= 0 ? "+" : ""}${item.pnl.toFixed(2)} USDT`}
        </span>
      </div>
    `).join("")
    : "Сделок пока нет";

  $("journalOrders").classList.toggle("empty-list", !rows.length);
}


$("saveProfileButton").addEventListener("click", async () => {
  const name = $("settingsName").value.trim();

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) {
    showToast("Имя: 3–24 латинские буквы, цифры или _");
    return;
  }

  $("saveProfileButton").disabled = true;

  try {
    const { data, error } = await supabaseClient.rpc(
      "update_own_profile_username",
      { p_username: name }
    );

    if (error) throw error;

    userProfile.username = data;
    initializeUser();
    showToast("Профиль обновлён");
  } catch (error) {
    console.error("Ошибка обновления профиля:", error);

    showToast(
      error?.message?.toLowerCase().includes("занято")
        ? "Такое имя пользователя уже занято"
        : error?.message || "Не удалось обновить профиль"
    );
  } finally {
    $("saveProfileButton").disabled = false;
  }
});

const restoredSection = localStorage.getItem("fastboot-active-section") || "overview";
document.documentElement.style.overflow = "";
document.body.style.overflow = "";
document.body.classList.remove("mobile-bottom-drawer-open");

$("changePasswordButton")?.addEventListener("click", async () => {
  const password = $("settingsNewPassword").value;
  const repeated = $("settingsRepeatPassword").value;

  if (password.length < 8) {
    showToast("Пароль должен содержать минимум 8 символов");
    return;
  }

  if (password !== repeated) {
    showToast("Пароли не совпадают");
    return;
  }

  $("changePasswordButton").disabled = true;

  try {
    const { error } = await supabaseClient.auth.updateUser({
      password,
    });

    if (error) throw error;

    $("settingsNewPassword").value = "";
    $("settingsRepeatPassword").value = "";
    showToast("Пароль успешно изменён");
  } catch (error) {
    console.error("Ошибка смены пароля:", error);
    showToast(error?.message || "Не удалось изменить пароль");
  } finally {
    $("changePasswordButton").disabled = false;
  }
});

$("logoutAllButton")?.addEventListener("click", async () => {
  if (!window.confirm("Выйти из аккаунта на всех устройствах?")) {
    return;
  }

  $("logoutAllButton").disabled = true;

  try {
    const { error } = await supabaseClient.auth.signOut({
      scope: "global",
    });

    if (error) throw error;

    window.location.replace("login.html");
  } catch (error) {
    console.error("Ошибка выхода со всех устройств:", error);
    showToast(error?.message || "Не удалось завершить все сессии");
    $("logoutAllButton").disabled = false;
  }
});

let accountRefreshTimer = null;

function startAccountAutoRefresh() {
  if (accountRefreshTimer) {
    clearInterval(accountRefreshTimer);
  }

  accountRefreshTimer = setInterval(() => {
    if (!document.hidden) {
      loadSupabaseAccountData().catch((error) => {
        console.error("Ошибка автоматического обновления:", error);
      });
    }
  }, 30000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadSupabaseAccountData().catch((error) => {
      console.error("Ошибка обновления после возвращения:", error);
    });
  }
});

startAccountAutoRefresh();

initializeUser();
applySupabaseWalletToPortfolio();
renderJournal();

loadSupabaseAccountData()
  .catch((error) => {
    console.error("Ошибка загрузки аккаунта:", error);
    showToast("Не удалось обновить данные. Показаны сохранённые значения.");

    Object.assign(userWallet, window.fastbootWallet || {});
    initializeUser();
    applySupabaseWalletToPortfolio();
    renderAccount();
    renderAiAssistant();
  })
  .finally(() => {
    loadPrices();
  });


window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;

  if (event.data?.type === "FASTBOOT_OPEN_SECTION") {
    const section = String(event.data.section || "overview");
    openSection(titles[section] ? section : "overview");
  }
});

window.openSection = openSection;

openSection(titles[restoredSection] ? restoredSection : "overview");

$("tradingHomeButton")?.addEventListener("click", () => {
  openSection("overview");
});


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


async function loadMarketUniverse() {
  const dropdown = $("marketPickerDropdown");
  const searchInput = $("marketSearchInput");

  // В актуальной версии торговый терминал работает в отдельном iframe.
  // Если старых элементов выбора рынка уже нет, просто ничего не делаем.
  if (!dropdown && !searchInput) {
    return [];
  }

  const fallbackSymbols = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "TRXUSDT",
  ];

  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/exchangeInfo",
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(`Market API ${response.status}`);
    }

    const data = await response.json();

    state.marketUniverse = (data.symbols || [])
      .filter((item) =>
        item.status === "TRADING" &&
        item.quoteAsset === "USDT" &&
        item.isSpotTradingAllowed !== false
      )
      .map((item) => item.symbol)
      .filter((symbol) => /^[A-Z0-9]{5,20}$/.test(symbol))
      .slice(0, 300);

    if (!state.marketUniverse.length) {
      state.marketUniverse = fallbackSymbols;
    }
  } catch (error) {
    console.warn("Market universe fallback:", error);
    state.marketUniverse = fallbackSymbols;
  }

  if (typeof renderMarketPicker === "function") {
    renderMarketPicker();
  }

  return state.marketUniverse;
}

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

loadMarketUniverse().catch((error) => {
  console.warn("Market universe startup skipped:", error);
});
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
