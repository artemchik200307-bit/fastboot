(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REST_BASES = [
    "https://api.binance.com",
    "https://data-api.binance.vision",
  ];
  const REFRESH_MS = 3000;

  let supabaseClient = null;
  let currentUser = null;
  let currentSymbol = "BTCUSDT";
  let currentInterval = "15m";
  let currentPrice = 0;
  let tradingBalance = 0;

  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let volumeVisible = true;
  let spotBalance = 0;
  let activeProtectionPosition = null;
  const closingPositionIds = new Set();
  const chartPriceLines = [];

  let drawingTool = "cursor";
  let drawingStart = null;
  let drawingPreview = null;
  let drawings = [];
  let drawingContext = null;

  const state = {
    positions: [],
    orders: [],
    trades: [],
  };

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatPrice(value) {
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

  function formatNumber(value, digits = 8) {
    const number = Number(value || 0);
    return Number.isFinite(number)
      ? number.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")
      : "0";
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString("ru-RU") : "—";
  }

  async function fetchJson(path) {
    let lastError = null;

    for (const base of REST_BASES) {
      try {
        const response = await fetch(`${base}${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Market API ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Market API недоступен");
  }

  async function initializeSupabase() {
    const parentWindow =
      window.parent && window.parent !== window ? window.parent : null;

    supabaseClient =
      parentWindow?.fastbootSupabase ||
      window.fastbootSupabase ||
      null;

    currentUser =
      parentWindow?.fastbootUser ||
      window.fastbootUser ||
      null;

    if (!supabaseClient) {
      throw new Error("Supabase-клиент терминала не найден");
    }

    if (!currentUser) {
      const { data, error } = await supabaseClient.auth.getUser();

      if (error || !data?.user) {
        throw new Error("Пользователь не авторизован");
      }

      currentUser = data.user;
    }
  }

  async function loadAccountData() {
    const [walletResult, positionsResult, ordersResult, tradesResult] =
      await Promise.all([
        supabaseClient.rpc("get_my_wallet"),

        supabaseClient
          .from("terminal_positions")
          .select("*")
          .eq("user_id", currentUser.id)
          .eq("status", "open")
          .order("opened_at", { ascending: false }),

        supabaseClient
          .from("terminal_orders")
          .select("*")
          .eq("user_id", currentUser.id)
          .eq("status", "open")
          .order("created_at", { ascending: false }),

        supabaseClient
          .from("terminal_trades")
          .select("*")
          .eq("user_id", currentUser.id)
          .order("closed_at", { ascending: false })
          .limit(100),
      ]);

    if (walletResult.error) throw walletResult.error;
    if (positionsResult.error) throw positionsResult.error;
    if (ordersResult.error) throw ordersResult.error;
    if (tradesResult.error) throw tradesResult.error;

    const loadedWallet = Array.isArray(walletResult.data)
      ? walletResult.data[0]
      : walletResult.data;

    tradingBalance = Number(loadedWallet?.trading_balance || 0);
    spotBalance = Number(loadedWallet?.spot_balance || 0);
    state.positions = positionsResult.data || [];
    state.orders = ordersResult.data || [];
    state.trades = tradesResult.data || [];

    if ($("tradingBalance")) {
      $("tradingBalance").textContent = `${tradingBalance.toFixed(2)} USDT`;
    }

    if ($("spotBalance")) {
      $("spotBalance").textContent = `${spotBalance.toFixed(2)} USDT`;
    }

    $("availableBalance").textContent =
      `${tradingBalance.toFixed(2)} USDT`;

    renderPositions();
    renderOrders();
    renderTrades();
    renderTradingLevels();
    updateOrderCalculation();
  }

  function createChart() {
    if (!window.LightweightCharts) {
      throw new Error("Библиотека графика не загрузилась");
    }

    const container = $("terminalChart");

    chart = LightweightCharts.createChart(container, {
      width: Math.max(container.clientWidth, 320),
      height: Math.max(container.clientHeight, 300),
      layout: {
        background: { type: "solid", color: "#101722" },
        textColor: "#8290a5",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(130,144,165,.08)" },
        horzLines: { color: "rgba(130,144,165,.08)" },
      },
      rightPriceScale: {
        borderColor: "#253248",
        scaleMargins: { top: .06, bottom: .22 },
      },
      timeScale: {
        borderColor: "#253248",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 18,
        barSpacing: 8,
        minBarSpacing: 3,
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
    });

    candleSeries = chart.addSeries(
      LightweightCharts.CandlestickSeries,
      {
        upColor: "#22c98a",
        downColor: "#ff5572",
        borderVisible: false,
        wickUpColor: "#22c98a",
        wickDownColor: "#ff5572",
      }
    );

    volumeSeries = chart.addSeries(
      LightweightCharts.HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        priceLineVisible: false,
        lastValueVisible: false,
      }
    );

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: .82, bottom: 0 },
    });

    new ResizeObserver(() => {
      chart.resize(
        Math.max(container.clientWidth, 320),
        Math.max(container.clientHeight, 300)
      );
      resizeDrawingCanvas();
      renderDrawings();
    }).observe(container);
  }

  async function loadMarket() {
    const [ticker, depth, klines] = await Promise.all([
      fetchJson(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(currentSymbol)}`),
      fetchJson(`/api/v3/depth?symbol=${encodeURIComponent(currentSymbol)}&limit=50`),
      fetchJson(
        `/api/v3/klines?symbol=${encodeURIComponent(currentSymbol)}` +
        `&interval=${encodeURIComponent(currentInterval)}&limit=300`
      ),
    ]);

    currentPrice = Number(ticker.lastPrice || 0);
    const change = Number(ticker.priceChangePercent || 0);

    if ($("marketPrice")) {
      $("marketPrice").textContent = formatPrice(currentPrice);
    }

    if ($("marketChange")) {
      $("marketChange").textContent =
        `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

      $("marketChange").className =
        change >= 0 ? "positive" : "negative";
    }

    $("statOpen").textContent = formatPrice(ticker.openPrice);
    $("statHigh").textContent = formatPrice(ticker.highPrice);
    $("statLow").textContent = formatPrice(ticker.lowPrice);
    $("statVolume").textContent = new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(Number(ticker.quoteVolume || 0));

    $("orderbookPrice").textContent = formatPrice(currentPrice);
    $("orderbookReference").textContent =
      `${change >= 0 ? "↑" : "↓"} ${formatPrice(ticker.prevClosePrice)}`;

    renderOrderbook(depth);

    candleSeries.setData(
      klines.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
      }))
    );

    volumeSeries.setData(
      klines.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        value: Number(row[5]),
        color:
          Number(row[4]) >= Number(row[1])
            ? "rgba(34,201,138,.42)"
            : "rgba(255,85,114,.42)",
      }))
    );

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({ rightOffset: 18 });

    if (!$("orderPrice").value || $("priceField").hidden) {
      $("orderPrice").value = currentPrice.toFixed(
        currentPrice >= 100 ? 2 : 6
      );
    }

    updatePositionsMarketPrice();
    await processLimitOrders();
    await processPositionProtection();
    renderTradingLevels();
    updateOrderCalculation();
    renderDrawings();
  }

  function renderOrderbook(depth) {
    const limit = matchMedia("(max-width: 760px)").matches ? 5 : 8;
    const precision = Number($("depthPrecision").value || .1);
    const normalize = (value) =>
      Math.round(Number(value) / precision) * precision;

    const asks = (depth.asks || []).slice(0, limit).reverse();
    const bids = (depth.bids || []).slice(0, limit);

    const maxAsk = Math.max(...asks.map((row) => Number(row[1])), 1);
    const maxBid = Math.max(...bids.map((row) => Number(row[1])), 1);

    $("asksList").innerHTML = asks.map((row) => {
      const price = normalize(row[0]);
      const quantity = Number(row[1]);
      const width = Math.min((quantity / maxAsk) * 100, 100);

      return `
        <div class="book-row ask" style="--depth:${width}%">
          <span>${formatPrice(price)}</span>
          <span>${formatNumber(quantity, 5)}</span>
        </div>
      `;
    }).join("");

    $("bidsList").innerHTML = bids.map((row) => {
      const price = normalize(row[0]);
      const quantity = Number(row[1]);
      const width = Math.min((quantity / maxBid) * 100, 100);

      return `
        <div class="book-row bid" style="--depth:${width}%">
          <span>${formatPrice(price)}</span>
          <span>${formatNumber(quantity, 5)}</span>
        </div>
      `;
    }).join("");

    const bidVolume = bids.reduce((sum, row) => sum + Number(row[1]), 0);
    const askVolume = asks.reduce((sum, row) => sum + Number(row[1]), 0);
    const total = Math.max(bidVolume + askVolume, 1);
    const bidRatio = (bidVolume / total) * 100;
    const askRatio = 100 - bidRatio;

    $("bidRatio").textContent = `${bidRatio.toFixed(2)}%`;
    $("askRatio").textContent = `${askRatio.toFixed(2)}%`;
    $("bidRatioBar").style.width = `${bidRatio}%`;
    $("askRatioBar").style.width = `${askRatio}%`;
  }

  function clearTradingLevels() {
    while (chartPriceLines.length) {
      const line = chartPriceLines.pop();

      try {
        candleSeries.removePriceLine(line);
      } catch {}
    }
  }

  function addTradingLevel(price, title, color, lineStyle = 2) {
    if (!(Number(price) > 0) || !candleSeries) return;

    const line = candleSeries.createPriceLine({
      price: Number(price),
      color,
      lineWidth: 1,
      lineStyle,
      axisLabelVisible: true,
      title,
    });

    chartPriceLines.push(line);
  }

  function renderTradingLevels() {
    clearTradingLevels();

    state.positions
      .filter((position) => position.symbol === currentSymbol)
      .forEach((position) => {
        addTradingLevel(
          position.entry_price,
          `${position.side} ENTRY`,
          "#6f91ff",
          2
        );

        if (Number(position.take_profit) > 0) {
          addTradingLevel(position.take_profit, "TP", "#22c98a", 2);
        }

        if (Number(position.stop_loss) > 0) {
          addTradingLevel(position.stop_loss, "SL", "#ff5572", 2);
        }
      });

    state.orders
      .filter((order) => order.symbol === currentSymbol)
      .forEach((order) => {
        addTradingLevel(
          order.price,
          `${order.side} LIMIT`,
          "#e5b85c",
          3
        );
      });
  }

  async function processPositionProtection() {
    const triggered = state.positions.filter((position) => {
      if (
        position.symbol !== currentSymbol ||
        closingPositionIds.has(position.id)
      ) {
        return false;
      }

      const tp = Number(position.take_profit || 0);
      const sl = Number(position.stop_loss || 0);

      if (position.side === "LONG") {
        return (tp > 0 && currentPrice >= tp) ||
          (sl > 0 && currentPrice <= sl);
      }

      return (tp > 0 && currentPrice <= tp) ||
        (sl > 0 && currentPrice >= sl);
    });

    for (const position of triggered) {
      closingPositionIds.add(position.id);

      try {
        const { error } = await supabaseClient.rpc(
          "close_terminal_position",
          {
            p_position_id: position.id,
            p_exit_price: currentPrice,
          }
        );

        if (error) throw error;

        showToast(
          `${position.symbol}: позиция закрыта по ${
            Number(position.take_profit) > 0 &&
            (
              (position.side === "LONG" && currentPrice >= Number(position.take_profit)) ||
              (position.side === "SHORT" && currentPrice <= Number(position.take_profit))
            )
              ? "Take Profit"
              : "Stop Loss"
          }`
        );
      } catch (error) {
        console.error("TP/SL close error:", error);
      } finally {
        closingPositionIds.delete(position.id);
      }
    }

    if (triggered.length) {
      await loadAccountData();
      notifyParentJournalRefresh();
    }
  }

  function openProtectionModal(positionId) {
    const position = state.positions.find((item) => item.id === positionId);
    if (!position) return;

    activeProtectionPosition = position;

    $("protectionPositionInfo").innerHTML = `
      <strong>${escapeHtml(position.symbol)} · ${escapeHtml(position.side)}</strong>
      <span>Цена входа: ${formatPrice(position.entry_price)}</span>
      <span>Текущая цена: ${formatPrice(
        position.symbol === currentSymbol
          ? currentPrice
          : position.entry_price
      )}</span>
    `;

    $("takeProfitInput").value =
      Number(position.take_profit) > 0 ? position.take_profit : "";

    $("stopLossInput").value =
      Number(position.stop_loss) > 0 ? position.stop_loss : "";

    $("protectionModal").classList.remove("hidden");
  }

  async function savePositionProtection(clear = false) {
    if (!activeProtectionPosition) return;

    const takeProfit = clear
      ? null
      : Number($("takeProfitInput").value || 0) || null;

    const stopLoss = clear
      ? null
      : Number($("stopLossInput").value || 0) || null;

    try {
      const { error } = await supabaseClient.rpc(
        "set_terminal_position_protection",
        {
          p_position_id: activeProtectionPosition.id,
          p_take_profit: takeProfit,
          p_stop_loss: stopLoss,
        }
      );

      if (error) throw error;

      $("protectionModal").classList.add("hidden");
      activeProtectionPosition = null;
      showToast(clear ? "TP/SL удалены" : "TP/SL сохранены");
      await loadAccountData();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось сохранить TP/SL");
    }
  }

  function notifyParentJournalRefresh() {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: "FASTBOOT_TERMINAL_JOURNAL_REFRESH" },
        window.location.origin
      );
    }
  }

  function currentOrderType() {
    return (
      document.querySelector("[data-order-type].active")?.dataset.orderType ||
      "LIMIT"
    );
  }

  function updateOrderCalculation() {
    const price =
      currentOrderType() === "MARKET"
        ? currentPrice
        : Number($("orderPrice").value || 0);

    const quantity = Number($("orderQuantity").value || 0);
    const total = Math.max(price * quantity, 0);

    $("orderTotal").textContent = `${total.toFixed(2)} USDT`;
    $("orderFee").textContent = `${(total * .001).toFixed(2)} USDT`;
  }

  function setQuantityPercent(percent) {
    const price =
      currentOrderType() === "MARKET"
        ? currentPrice
        : Number($("orderPrice").value || 0);

    if (!(price > 0)) {
      showToast("Цена ещё не загружена");
      return;
    }

    const quantity = (tradingBalance * (Number(percent) / 100)) / price;
    $("orderQuantity").value = quantity > 0 ? quantity.toFixed(8) : "";
    updateOrderCalculation();
  }

  async function placeOrder(side) {
    const type = currentOrderType();
    const quantity = Number($("orderQuantity").value || 0);
    const price =
      type === "MARKET"
        ? currentPrice
        : Number($("orderPrice").value || 0);

    if (!(price > 0) || !(quantity > 0)) {
      showToast("Введите цену и количество");
      return;
    }

    try {
      const rpc =
        type === "MARKET"
          ? "open_terminal_market_position"
          : "create_terminal_limit_order";

      const params =
        type === "MARKET"
          ? {
              p_symbol: currentSymbol,
              p_side: side,
              p_price: currentPrice,
              p_quantity: quantity,
            }
          : {
              p_symbol: currentSymbol,
              p_side: side,
              p_limit_price: price,
              p_quantity: quantity,
            };

      const { error } = await supabaseClient.rpc(rpc, params);
      if (error) throw error;

      $("orderQuantity").value = "";
      showToast(type === "MARKET" ? "Позиция открыта" : "Лимитный ордер создан");
      await loadAccountData();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось создать ордер");
    }
  }

  async function processLimitOrders() {
    const matching = state.orders.filter((order) => {
      if (order.symbol !== currentSymbol || order.status !== "open") return false;

      const price = Number(order.price);

      return order.side === "LONG"
        ? currentPrice <= price
        : currentPrice >= price;
    });

    for (const order of matching) {
      const { error } = await supabaseClient.rpc(
        "fill_terminal_limit_order",
        {
          p_order_id: order.id,
          p_fill_price: currentPrice,
        }
      );

      if (!error) showToast(`${order.symbol}: лимитный ордер исполнен`);
    }

    if (matching.length) await loadAccountData();
  }

  function updatePositionsMarketPrice() {
    state.positions = state.positions.map((position) => {
      if (position.symbol !== currentSymbol) return position;

      const entry = Number(position.entry_price);
      const quantity = Number(position.quantity);
      const pnl =
        position.side === "LONG"
          ? (currentPrice - entry) * quantity
          : (entry - currentPrice) * quantity;

      return { ...position, current_price: currentPrice, live_pnl: pnl };
    });

    renderPositions();
  }

  function renderPositions() {
    $("positionsCount").textContent = `(${state.positions.length})`;

    $("positionsBody").innerHTML = state.positions.length
      ? state.positions.map((position) => {
          const livePrice =
            Number(position.current_price) ||
            (position.symbol === currentSymbol
              ? currentPrice
              : Number(position.entry_price));

          const pnl =
            Number.isFinite(Number(position.live_pnl))
              ? Number(position.live_pnl)
              : position.side === "LONG"
                ? (livePrice - Number(position.entry_price)) *
                  Number(position.quantity)
                : (Number(position.entry_price) - livePrice) *
                  Number(position.quantity);

          return `
            <tr>
              <td><strong>${escapeHtml(position.symbol)}</strong></td>
              <td class="${position.side === "LONG" ? "positive" : "negative"}">
                ${escapeHtml(position.side)}
              </td>
              <td>${formatPrice(position.entry_price)}</td>
              <td>${formatPrice(livePrice)}</td>
              <td>${formatNumber(position.quantity)}</td>
              <td>${Number(position.margin).toFixed(2)} USDT</td>
              <td class="${pnl >= 0 ? "positive" : "negative"}">
                ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT
              </td>
              <td>
                <div class="position-protection">
                  <span class="tp">TP: ${
                    Number(position.take_profit) > 0
                      ? formatPrice(position.take_profit)
                      : "—"
                  }</span>
                  <span class="sl">SL: ${
                    Number(position.stop_loss) > 0
                      ? formatPrice(position.stop_loss)
                      : "—"
                  }</span>
                </div>
              </td>
              <td>
                <div class="position-actions">
                  <button data-protection-position="${position.id}">TP/SL</button>
                  <button data-close-position="${position.id}">Закрыть</button>
                </div>
              </td>
            </tr>
          `;
        }).join("")
      : '<tr><td colspan="9" class="empty-row">Открытых позиций нет</td></tr>';

    document.querySelectorAll("[data-close-position]").forEach((button) => {
      button.onclick = () => closePosition(button.dataset.closePosition);
    });

    document.querySelectorAll("[data-protection-position]").forEach((button) => {
      button.onclick = () =>
        openProtectionModal(button.dataset.protectionPosition);
    });
  }

  function renderOrders() {
    $("ordersCount").textContent = `(${state.orders.length})`;

    $("ordersBody").innerHTML = state.orders.length
      ? state.orders.map((order) => `
          <tr>
            <td><strong>${escapeHtml(order.symbol)}</strong></td>
            <td class="${order.side === "LONG" ? "positive" : "negative"}">${escapeHtml(order.side)}</td>
            <td>${escapeHtml(order.order_type)}</td>
            <td>${formatPrice(order.price)}</td>
            <td>${formatNumber(order.quantity)}</td>
            <td>${Number(order.reserved_amount).toFixed(2)} USDT</td>
            <td>${formatDate(order.created_at)}</td>
            <td><button data-cancel-order="${order.id}">Отменить</button></td>
          </tr>
        `).join("")
      : '<tr><td colspan="8" class="empty-row">Открытых ордеров нет</td></tr>';

    document.querySelectorAll("[data-cancel-order]").forEach((button) => {
      button.onclick = () => cancelOrder(button.dataset.cancelOrder);
    });
  }

  function renderTrades() {
    $("tradesBody").innerHTML = state.trades.length
      ? state.trades.map((trade) => `
          <tr>
            <td><strong>${escapeHtml(trade.symbol)}</strong></td>
            <td class="${trade.side === "LONG" ? "positive" : "negative"}">${escapeHtml(trade.side)}</td>
            <td>${formatPrice(trade.entry_price)}</td>
            <td>${formatPrice(trade.exit_price)}</td>
            <td>${formatNumber(trade.quantity)}</td>
            <td class="${Number(trade.pnl) >= 0 ? "positive" : "negative"}">${Number(trade.pnl) >= 0 ? "+" : ""}${Number(trade.pnl).toFixed(2)} USDT</td>
            <td class="${Number(trade.pnl_percent) >= 0 ? "positive" : "negative"}">${Number(trade.pnl_percent) >= 0 ? "+" : ""}${Number(trade.pnl_percent).toFixed(2)}%</td>
            <td>${formatDate(trade.closed_at)}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="8" class="empty-row">История сделок пуста</td></tr>';
  }

  async function closePosition(positionId) {
    try {
      const { error } = await supabaseClient.rpc(
        "close_terminal_position",
        {
          p_position_id: positionId,
          p_exit_price: currentPrice,
        }
      );

      if (error) throw error;

      showToast("Позиция закрыта");
      await loadAccountData();
      notifyParentJournalRefresh();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось закрыть позицию");
    }
  }

  async function cancelOrder(orderId) {
    try {
      const { error } = await supabaseClient.rpc(
        "cancel_terminal_limit_order",
        { p_order_id: orderId }
      );

      if (error) throw error;

      showToast("Ордер отменён");
      await loadAccountData();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось отменить ордер");
    }
  }

  // ---------- drawing tools ----------
  function drawingKey() {
    return `fastboot-drawings-${currentSymbol}-${currentInterval}`;
  }

  function loadDrawings() {
    try {
      drawings = JSON.parse(localStorage.getItem(drawingKey()) || "[]");
    } catch {
      drawings = [];
    }
    renderDrawings();
  }

  function saveDrawings() {
    localStorage.setItem(drawingKey(), JSON.stringify(drawings));
  }

  function resizeDrawingCanvas() {
    const canvas = $("drawingCanvas");
    const stage = canvas.parentElement;
    const ratio = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(stage.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(stage.clientHeight * ratio));
    canvas.style.width = `${stage.clientWidth}px`;
    canvas.style.height = `${stage.clientHeight}px`;

    drawingContext = canvas.getContext("2d");
    drawingContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawingContext.lineWidth = 1.5;
    drawingContext.font = "12px Inter, sans-serif";
  }

  function pointFromEvent(event) {
    const rect = $("drawingCanvas").getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(event.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(event.clientY - rect.top, rect.height)),
    };
  }

  function renderDrawings() {
    if (!drawingContext) resizeDrawingCanvas();

    const canvas = $("drawingCanvas");
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    drawingContext.clearRect(0, 0, width, height);

    const items = drawingPreview ? [...drawings, drawingPreview] : drawings;

    items.forEach((item) => {
      drawingContext.save();
      drawingContext.strokeStyle = "#8fa8ff";
      drawingContext.fillStyle = "#8fa8ff";

      if (item.type === "trend") {
        drawingContext.beginPath();
        drawingContext.moveTo(item.x1, item.y1);
        drawingContext.lineTo(item.x2, item.y2);
        drawingContext.stroke();
      }

      if (item.type === "horizontal") {
        drawingContext.beginPath();
        drawingContext.moveTo(0, item.y1);
        drawingContext.lineTo(width, item.y1);
        drawingContext.stroke();
      }

      if (item.type === "vertical") {
        drawingContext.beginPath();
        drawingContext.moveTo(item.x1, 0);
        drawingContext.lineTo(item.x1, height);
        drawingContext.stroke();
      }

      if (item.type === "rectangle") {
        const x = Math.min(item.x1, item.x2);
        const y = Math.min(item.y1, item.y2);
        const w = Math.abs(item.x2 - item.x1);
        const h = Math.abs(item.y2 - item.y1);

        drawingContext.fillStyle = "rgba(111,145,255,.10)";
        drawingContext.fillRect(x, y, w, h);
        drawingContext.strokeRect(x, y, w, h);
      }

      if (item.type === "text") {
        drawingContext.fillText(item.text || "Текст", item.x1, item.y1);
      }

      drawingContext.restore();
    });
  }

  function setDrawingTool(tool) {
    drawingTool = tool;
    drawingStart = null;
    drawingPreview = null;

    document.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });

    $("drawingCanvas").classList.toggle("active", tool !== "cursor");

    const hint = $("drawingHint");
    const messages = {
      trend: "Проведите линию между двумя точками",
      horizontal: "Нажмите в месте уровня",
      vertical: "Нажмите в месте вертикальной линии",
      rectangle: "Выделите область",
      text: "Нажмите в месте текста",
    };

    if (tool === "cursor") {
      hint.classList.add("hidden");
    } else {
      hint.textContent = messages[tool] || "";
      hint.classList.remove("hidden");
    }

    renderDrawings();
  }

  function beginDrawing(event) {
    if (drawingTool === "cursor") return;

    const point = pointFromEvent(event);

    if (drawingTool === "horizontal") {
      drawings.push({ type: "horizontal", y1: point.y });
      saveDrawings();
      renderDrawings();
      return;
    }

    if (drawingTool === "vertical") {
      drawings.push({ type: "vertical", x1: point.x });
      saveDrawings();
      renderDrawings();
      return;
    }

    if (drawingTool === "text") {
      const text = window.prompt("Введите текст:");
      if (text?.trim()) {
        drawings.push({
          type: "text",
          x1: point.x,
          y1: point.y,
          text: text.trim().slice(0, 80),
        });
        saveDrawings();
        renderDrawings();
      }
      return;
    }

    drawingStart = point;
    drawingPreview = {
      type: drawingTool,
      x1: point.x,
      y1: point.y,
      x2: point.x,
      y2: point.y,
    };

    $("drawingCanvas").setPointerCapture?.(event.pointerId);
  }

  function moveDrawing(event) {
    if (!drawingStart || !drawingPreview) return;
    const point = pointFromEvent(event);
    drawingPreview.x2 = point.x;
    drawingPreview.y2 = point.y;
    renderDrawings();
  }

  function finishDrawing(event) {
    if (!drawingStart || !drawingPreview) return;

    const point = pointFromEvent(event);
    drawingPreview.x2 = point.x;
    drawingPreview.y2 = point.y;

    if (
      Math.hypot(
        drawingPreview.x2 - drawingPreview.x1,
        drawingPreview.y2 - drawingPreview.y1
      ) >= 4
    ) {
      drawings.push({ ...drawingPreview });
      saveDrawings();
    }

    drawingStart = null;
    drawingPreview = null;
    renderDrawings();
  }

  function undoDrawing() {
    drawings.pop();
    saveDrawings();
    renderDrawings();
  }

  function clearDrawings() {
    if (!drawings.length) return;
    if (window.confirm("Удалить все объекты на графике?")) {
      drawings = [];
      saveDrawings();
      renderDrawings();
    }
  }

  function openChartMobile() {
    document.body.classList.add("chart-open");
    $("mobileTerminalButton").classList.remove("active");
    $("mobileChartButton").classList.add("active");

    requestAnimationFrame(() => {
      chart.resize(
        Math.max($("terminalChart").clientWidth, 320),
        Math.max($("terminalChart").clientHeight, 300)
      );
      resizeDrawingCanvas();
      chart.timeScale().fitContent();
      chart.timeScale().applyOptions({ rightOffset: 18 });
      renderDrawings();
    });
  }

  function closeChartMobile() {
    document.body.classList.remove("chart-open");
    $("mobileChartButton").classList.remove("active");
    $("mobileTerminalButton").classList.add("active");
  }

  function bindEvents() {
    $("dashboardHomeButton").onclick = () => {
      try {
        if (
          window.parent &&
          window.parent !== window &&
          typeof window.parent.openSection === "function"
        ) {
          window.parent.openSection("overview");
          return;
        }
      } catch {}

      window.top.location.href = "dashboard.html";
    };

    $("mobileChartButton").onclick = openChartMobile;
    $("mobileTerminalButton").onclick = closeChartMobile;
    $("chartBackButton").onclick = closeChartMobile;

    $("symbolSelect").onchange = async (event) => {
      currentSymbol = event.target.value;
      $("baseAssetLabel").textContent = currentSymbol.replace("USDT", "");
      loadDrawings();
      await loadMarket();
    };

    document.querySelectorAll("[data-interval]").forEach((button) => {
      button.onclick = async () => {
        document.querySelectorAll("[data-interval]").forEach((item) =>
          item.classList.toggle("active", item === button)
        );

        currentInterval = button.dataset.interval;
        loadDrawings();
        await loadMarket();
      };
    });

    document.querySelectorAll("[data-tool]").forEach((button) => {
      button.onclick = () => setDrawingTool(button.dataset.tool);
    });

    document.querySelector('[data-action="undo"]').onclick = undoDrawing;
    document.querySelector('[data-action="clear"]').onclick = clearDrawings;

    $("drawingCanvas").addEventListener("pointerdown", beginDrawing);
    $("drawingCanvas").addEventListener("pointermove", moveDrawing);
    $("drawingCanvas").addEventListener("pointerup", finishDrawing);
    $("drawingCanvas").addEventListener("pointercancel", finishDrawing);

    $("toggleVolumeButton").onclick = () => {
      volumeVisible = !volumeVisible;
      volumeSeries.applyOptions({ visible: volumeVisible });
      $("toggleVolumeButton").classList.toggle("active", volumeVisible);
    };

    $("resetChartButton").onclick = () => {
      chart.timeScale().fitContent();
      chart.timeScale().applyOptions({ rightOffset: 18 });
      renderDrawings();
    };

    $("refreshChartButton").onclick = loadMarket;
    $("depthPrecision").onchange = loadMarket;

    document.querySelectorAll("[data-order-type]").forEach((button) => {
      button.onclick = () => {
        document.querySelectorAll("[data-order-type]").forEach((item) =>
          item.classList.toggle("active", item === button)
        );

        const market = button.dataset.orderType === "MARKET";
        $("priceField").hidden = market;

        if (market) $("orderPrice").value = currentPrice;
        updateOrderCalculation();
      };
    });

    document.querySelectorAll("[data-percent]").forEach((button) => {
      button.onclick = () => setQuantityPercent(button.dataset.percent);
    });

    $("orderPrice").oninput = updateOrderCalculation;
    $("orderQuantity").oninput = updateOrderCalculation;
    $("buyButton").onclick = () => placeOrder("LONG");
    $("sellButton").onclick = () => placeOrder("SHORT");

    document.querySelectorAll("[data-bottom-tab]").forEach((button) => {
      button.onclick = () => {
        document.querySelectorAll("[data-bottom-tab]").forEach((item) =>
          item.classList.toggle("active", item === button)
        );

        document.querySelectorAll(".tab-content").forEach((panel) =>
          panel.classList.toggle(
            "active",
            panel.id === `${button.dataset.bottomTab}Tab`
          )
        );
      };
    });

    $("closeProtectionModal").onclick = () => {
      $("protectionModal").classList.add("hidden");
      activeProtectionPosition = null;
    };

    $("saveProtectionButton").onclick = () =>
      savePositionProtection(false);

    $("clearProtectionButton").onclick = () =>
      savePositionProtection(true);

    $("openTransferButton").onclick = () =>
      $("transferModal").classList.remove("hidden");

    $("closeTransferModal").onclick = () =>
      $("transferModal").classList.add("hidden");

    $("confirmTransferButton").onclick = async () => {
      const direction = $("transferDirection").value;
      const amount = Number($("transferAmount").value || 0);

      if (!(amount > 0)) {
        showToast("Введите сумму");
        return;
      }

      try {
        const { error } = await supabaseClient.rpc(
          "transfer_trading_balance",
          {
            p_direction: direction,
            p_amount: amount,
          }
        );

        if (error) throw error;

        $("transferAmount").value = "";
        $("transferModal").classList.add("hidden");
        showToast("Перевод выполнен");
        await loadAccountData();
      } catch (error) {
        console.error(error);
        showToast(error.message || "Не удалось выполнить перевод");
      }
    };

    window.addEventListener("resize", () => {
      if (!matchMedia("(max-width: 760px)").matches) closeChartMobile();

      if (chart) {
        chart.resize(
          Math.max($("terminalChart").clientWidth, 320),
          Math.max($("terminalChart").clientHeight, 300)
        );
        resizeDrawingCanvas();
        renderDrawings();
      }
    });

    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "FASTBOOT_TERMINAL_REFRESH") {
        loadAccountData().catch(console.error);
      }
    });
  }

  async function refreshLoop() {
    try {
      await loadMarket();

      if (!refreshLoop.counter || refreshLoop.counter % 3 === 0) {
        await loadAccountData();
      }

      refreshLoop.counter = (refreshLoop.counter || 0) + 1;
    } catch (error) {
      console.error(error);
    }
  }

  async function start() {
    try {
      await initializeSupabase();
      createChart();
      bindEvents();
      resizeDrawingCanvas();
      loadDrawings();
      setDrawingTool("cursor");

      $("baseAssetLabel").textContent = currentSymbol.replace("USDT", "");

      await loadMarket();

      try {
        await loadAccountData();
      } catch (accountError) {
        console.error("Terminal account data error:", accountError);
        showToast("График работает, но торговый счёт временно недоступен");
      }

      setInterval(refreshLoop, REFRESH_MS);
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось запустить терминал");
    }
  }

  start();
})();
