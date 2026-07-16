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
  tradeSocket: null,
  currentSymbol: "BTCUSDT",
  orderSide: "BUY",
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
  document.querySelectorAll(".dashboard-section").forEach((el) => el.classList.toggle("active", el.id === id));
  document.querySelectorAll(".nav-item[data-section]").forEach((el) => el.classList.toggle("active", el.dataset.section === id));
  $("pageTitle").textContent = titles[id] || "FASTBOOT";
  $("sidebar").classList.remove("open");
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
$("botRiskSettingsButton").addEventListener("click",()=>{
  $("modalTitle").textContent = "Риск-менеджмент бота";
  $("modalBody").innerHTML = `<div class="modal-form"><label>Риск на сделку, %<input id="botRiskInput" type="number" value="${localStorage.getItem("fastboot-bot-risk")||1}" min=".1" max="10" step=".1"></label><label>Максимум сделок в день<input id="botMaxTrades" type="number" value="${localStorage.getItem("fastboot-bot-max-trades")||3}" min="1"></label><button id="saveBotRisk" class="primary-action">Сохранить</button></div>`;
  $("actionModal").classList.remove("hidden");
  $("saveBotRisk").addEventListener("click",()=>{localStorage.setItem("fastboot-bot-risk",$("botRiskInput").value);localStorage.setItem("fastboot-bot-max-trades",$("botMaxTrades").value);$("actionModal").classList.add("hidden");showToast("Настройки риска сохранены")});
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

async function loadTradingTerminal() {
  const symbol = $("tradeSymbolSelect").value;
  const interval = $("tradeIntervalSelect").value;
  state.currentSymbol = symbol;

  const [klines, ticker, depth, trades] = await Promise.all([
    fetchJson(`${REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=300`),
    fetchJson(`${REST_BASE}/api/v3/ticker/24hr?symbol=${symbol}`),
    fetchJson(`${REST_BASE}/api/v3/depth?symbol=${symbol}&limit=10`),
    fetchJson(`${REST_BASE}/api/v3/trades?symbol=${symbol}&limit=20`)
  ]);

  $("terminalPrice").textContent = formatPrice(ticker.lastPrice);
  const change = Number(ticker.priceChangePercent);
  $("terminalChange").textContent = `${change>=0?"+":""}${change.toFixed(2)}%`;
  $("terminalChange").className = change>=0?"positive":"negative";
  $("orderPrice").placeholder = formatPrice(ticker.lastPrice);
  $("orderbookMid").textContent = formatPrice(ticker.lastPrice);

  renderOrderbook(depth); renderRecentTrades(trades); renderChart(klines);
}

function renderChart(rows) {
  const container = $("terminalChart");
  if (!state.chart) {
    state.chart = LightweightCharts.createChart(container,{width:container.clientWidth,height:container.clientHeight,layout:{background:{type:"solid",color:"#080c12"},textColor:"#8894a7",attributionLogo:false},grid:{vertLines:{color:"rgba(128,140,160,.1)"},horzLines:{color:"rgba(128,140,160,.1)"}},timeScale:{timeVisible:true},handleScroll:true,handleScale:true});
    state.candleSeries = state.chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:"#20c987",downColor:"#ff5f78",borderVisible:false,wickUpColor:"#20c987",wickDownColor:"#ff5f78"});
    new ResizeObserver(()=>state.chart.resize(container.clientWidth,container.clientHeight)).observe(container);
  }
  state.candleSeries.setData(rows.map(r=>({time:Math.floor(r[0]/1000),open:+r[1],high:+r[2],low:+r[3],close:+r[4]})));
  state.chart.timeScale().fitContent();
}

function renderOrderbook(depth) {
  $("asksList").innerHTML = [...depth.asks].reverse().slice(0,8).map(x=>`<div class="orderbook-row"><span>${formatPrice(x[0])}</span><span>${(+x[1]).toFixed(5)}</span></div>`).join("");
  $("bidsList").innerHTML = depth.bids.slice(0,8).map(x=>`<div class="orderbook-row"><span>${formatPrice(x[0])}</span><span>${(+x[1]).toFixed(5)}</span></div>`).join("");
}
function renderRecentTrades(trades) {
  $("recentTradesList").innerHTML = trades.reverse().map(t=>`<div class="recent-row"><span class="${t.isBuyerMaker?"negative":"positive"}">${formatPrice(t.price)}</span><span>${(+t.qty).toFixed(5)}</span><span>${new Date(t.time).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span></div>`).join("");
}

$("tradeSymbolSelect").addEventListener("change",loadTradingTerminal);
$("tradeIntervalSelect").addEventListener("change",loadTradingTerminal);
document.querySelectorAll(".order-tabs button").forEach(btn=>btn.addEventListener("click",()=>{
  state.orderSide=btn.dataset.side; document.querySelectorAll(".order-tabs button").forEach(x=>x.classList.toggle("active",x===btn));
  $("placeOrderButton").textContent=state.orderSide==="BUY"?"Купить":"Продать";
  $("placeOrderButton").className=state.orderSide==="BUY"?"buy-order-button":"sell-order-button";
}));
["orderPrice","orderAmount"].forEach(id=>$(id).addEventListener("input",()=>{
  const price=Number($("orderPrice").value)||Number($("terminalPrice").textContent.replaceAll(",",""));
  const amount=Number($("orderAmount").value)||0; $("orderTotal").textContent=`${(price*amount).toFixed(2)} USDT`;
}));
$("placeOrderButton").addEventListener("click",()=>{
  const amount=Number($("orderAmount").value); const type=$("orderType").value;
  const price=type==="MARKET"?Number($("terminalPrice").textContent.replaceAll(",","")):Number($("orderPrice").value);
  if (!(amount>0)||!(price>0)) return showToast("Введите цену и количество");
  state.orders.unshift({date:new Date().toLocaleString("ru-RU"),symbol:state.currentSymbol,type,side:state.orderSide,price,amount,status:"Локально",total:price*amount});
  saveState(); renderOrders(); $("orderAmount").value=""; showToast("Ордер добавлен в локальную историю");
});

function renderOrders() {
  const html = state.orders.length ? state.orders.map(o=>`<div class="order-history-row"><span>${o.date}</span><strong>${o.symbol}</strong><span>${o.type}</span><span class="${o.side==="BUY"?"positive":"negative"}">${o.side}</span><span>${formatPrice(o.price)}</span><span>${o.amount}</span><span>${o.status}</span></div>`).join("") : "Ордеров пока нет";
  $("ordersHistory").innerHTML=html; $("ordersHistory").classList.toggle("empty-list",!state.orders.length);
}

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
