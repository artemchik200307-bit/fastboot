(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REST_BASES = ["https://api.binance.com", "https://data-api.binance.vision"];
  const REFRESH_MS = 3000;

  let supabaseClient = null;
  let currentUser = null;
  let currentSymbol = "BTCUSDT";
  let currentInterval = "15m";
  let currentPrice = 0;
  let currentTicker = null;
  let tradingBalance = 0;
  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let refreshTimer = null;
  let volumeVisible = true;
  let activeDrawingTool = "cursor";
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
    showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
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
    if (!value) return "—";
    return new Date(value).toLocaleString("ru-RU");
  }

  async function fetchJson(path) {
    let lastError = null;

    for (const base of REST_BASES) {
      try {
        const response = await fetch(`${base}${path}`, {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Market API ${response.status}`);
        }

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

  async function loadWalletAndAccountData() {
    const [walletResult, positionsResult, ordersResult, tradesResult] =
      await Promise.all([
        supabaseClient
          .from("wallets")
          .select("spot_balance, trading_balance")
          .eq("user_id", currentUser.id)
          .single(),

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

    tradingBalance = Number(walletResult.data?.trading_balance || 0);
    state.positions = positionsResult.data || [];
    state.orders = ordersResult.data || [];
    state.trades = tradesResult.data || [];

    $("tradingBalance").textContent = `${tradingBalance.toFixed(2)} USDT`;
    $("availableBalance").textContent = `${tradingBalance.toFixed(2)} USDT`;

    renderPositions();
    renderOrders();
    renderTrades();
    updateOrderCalculation();
  }

  function createChart() {
    const container = $("terminalChart");

    if (!window.LightweightCharts) {
      container.innerHTML =
        '<div class="terminal-chart-error">Не удалось загрузить библиотеку графика</div>';
      throw new Error("Lightweight Charts не загружен");
    }

    chart = LightweightCharts.createChart(container, {
      width: Math.max(container.clientWidth, 320),
      height: Math.max(container.clientHeight, 300),
      layout: {
        background: { type: "solid", color: "#101722" },
        textColor: "#8290a6",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(130,144,166,.08)" },
        horzLines: { color: "rgba(130,144,166,.08)" },
      },
      rightPriceScale: {
        borderColor: "#263247",
        scaleMargins: { top: .06, bottom: .22 },
      },
      timeScale: {
        borderColor: "#263247",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 18,
        barSpacing: 8,
        minBarSpacing: 3,
      },
    });

    candleSeries = chart.addSeries(
      LightweightCharts.CandlestickSeries,
      {
        upColor: "#20c987",
        downColor: "#ff5571",
        borderVisible: false,
        wickUpColor: "#20c987",
        wickDownColor: "#ff5571",
      }
    );

    volumeSeries = chart.addSeries(
      LightweightCharts.HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
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
      fetchJson(
        `/api/v3/ticker/24hr?symbol=${encodeURIComponent(currentSymbol)}`
      ),
      fetchJson(
        `/api/v3/depth?symbol=${encodeURIComponent(currentSymbol)}&limit=50`
      ),
      fetchJson(
        `/api/v3/klines?symbol=${encodeURIComponent(currentSymbol)}` +
        `&interval=${encodeURIComponent(currentInterval)}&limit=300`
      ),
    ]);

    currentTicker = ticker;
    currentPrice = Number(ticker.lastPrice || 0);

    const change = Number(ticker.priceChangePercent || 0);
    $("marketPrice").textContent = formatPrice(currentPrice);
    $("marketChange").textContent =
      `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("marketChange").className = change >= 0 ? "positive" : "negative";

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

    const limit = matchMedia("(max-width: 760px)").matches ? 5 : 8;
    renderOrderbook(depth, limit);

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
            ? "rgba(32,201,135,.4)"
            : "rgba(255,85,113,.4)",
      }))
    );

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({ rightOffset: 18 });
    renderDrawings();

    if (!$("orderPrice").value || $("priceField").hidden) {
      $("orderPrice").value = currentPrice.toFixed(
        currentPrice >= 100 ? 2 : 6
      );
    }

    updatePositionsMarketPrice();
    await processLimitOrders();
    updateOrderCalculation();
  }

  function renderOrderbook(depth, limit) {
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
      const depthPercent = Math.min((quantity / maxAsk) * 100, 100);

      return `
        <div class="orderbook-row ask" style="--depth:${depthPercent}%">
          <span>${formatPrice(price)}</span>
          <span>${formatNumber(quantity, 5)}</span>
        </div>
      `;
    }).join("");

    $("bidsList").innerHTML = bids.map((row) => {
      const price = normalize(row[0]);
      const quantity = Number(row[1]);
      const depthPercent = Math.min((quantity / maxBid) * 100, 100);

      return `
        <div class="orderbook-row bid" style="--depth:${depthPercent}%">
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

  function drawingStorageKey() {
    return `fastboot-terminal-drawings-${currentSymbol}-${currentInterval}`;
  }

  function loadDrawings() {
    try {
      drawings = JSON.parse(localStorage.getItem(drawingStorageKey()) || "[]");
    } catch {
      drawings = [];
    }

    renderDrawings();
  }

  function saveDrawings() {
    localStorage.setItem(drawingStorageKey(), JSON.stringify(drawings));
  }

  function resizeDrawingCanvas() {
    const canvas = $("drawingCanvas");
    const stage = canvas?.parentElement;

    if (!canvas || !stage) return;

    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);

    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    drawingContext = canvas.getContext("2d");
    drawingContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawingContext.lineWidth = 1.5;
    drawingContext.font = '12px Inter, sans-serif';
  }

  function pointFromEvent(event) {
    const canvas = $("drawingCanvas");
    const rect = canvas.getBoundingClientRect();

    return {
      x: Math.max(0, Math.min(event.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(event.clientY - rect.top, rect.height)),
    };
  }

  function renderDrawings() {
    const canvas = $("drawingCanvas");
    if (!canvas) return;

    if (!drawingContext) resizeDrawingCanvas();
    if (!drawingContext) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    drawingContext.clearRect(0, 0, width, height);

    const all = drawingPreview ? [...drawings, drawingPreview] : drawings;

    all.forEach((item) => {
      drawingContext.save();
      drawingContext.strokeStyle = item.color || "#8fa8ff";
      drawingContext.fillStyle = item.color || "#8fa8ff";
      drawingContext.lineWidth = item.width || 1.5;

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
    activeDrawingTool = tool;
    drawingStart = null;
    drawingPreview = null;

    document.querySelectorAll("[data-drawing-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.drawingTool === tool);
    });

    const canvas = $("drawingCanvas");
    canvas.classList.toggle("active", tool !== "cursor");

    const hint = $("drawingHint");

    if (tool === "cursor") {
      hint.classList.add("hidden");
    } else {
      const messages = {
        trend: "Проведите линию между двумя точками",
        horizontal: "Нажмите в месте горизонтального уровня",
        vertical: "Нажмите в месте вертикального уровня",
        rectangle: "Выделите прямоугольную область",
        text: "Нажмите в месте для текста",
      };

      hint.textContent = messages[tool] || "";
      hint.classList.remove("hidden");
    }

    renderDrawings();
  }

  function beginDrawing(event) {
    if (activeDrawingTool === "cursor") return;

    const point = pointFromEvent(event);

    if (activeDrawingTool === "horizontal") {
      drawings.push({
        type: "horizontal",
        y1: point.y,
      });
      saveDrawings();
      renderDrawings();
      return;
    }

    if (activeDrawingTool === "vertical") {
      drawings.push({
        type: "vertical",
        x1: point.x,
      });
      saveDrawings();
      renderDrawings();
      return;
    }

    if (activeDrawingTool === "text") {
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
      type: activeDrawingTool,
      x1: point.x,
      y1: point.y,
      x2: point.x,
      y2: point.y,
    };

    $("drawingCanvas").setPointerCapture?.(event.pointerId);
    renderDrawings();
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

    const distance = Math.hypot(
      drawingPreview.x2 - drawingPreview.x1,
      drawingPreview.y2 - drawingPreview.y1
    );

    if (distance >= 4) {
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

    if (window.confirm("Удалить все графические объекты на этом графике?")) {
      drawings = [];
      saveDrawings();
      renderDrawings();
    }
  }

  function updateOrderCalculation() {
    const orderType =
      document.querySelector("[data-order-type].active")?.dataset.orderType ||
      "LIMIT";

    const price =
      orderType === "MARKET"
        ? currentPrice
        : Number($("orderPrice").value || 0);

    const quantity = Number($("orderQuantity").value || 0);
    const total = Math.max(price * quantity, 0);

    $("orderTotal").textContent = `${total.toFixed(2)} USDT`;
    $("orderFee").textContent = `${(total * .001).toFixed(2)} USDT`;
  }

  function setQuantityFromPercent(percent) {
    const orderType =
      document.querySelector("[data-order-type].active")?.dataset.orderType ||
      "LIMIT";
    const price =
      orderType === "MARKET"
        ? currentPrice
        : Number($("orderPrice").value || 0);

    if (!(price > 0)) return;

    const quantity = (tradingBalance * (Number(percent) / 100)) / price;
    $("orderQuantity").value =
      quantity > 0 ? quantity.toFixed(8) : "";
    updateOrderCalculation();
  }

  async function placeOrder(side) {
    const orderType =
      document.querySelector("[data-order-type].active")?.dataset.orderType ||
      "LIMIT";

    const quantity = Number($("orderQuantity").value || 0);
    const price =
      orderType === "MARKET"
        ? currentPrice
        : Number($("orderPrice").value || 0);

    if (!(quantity > 0) || !(price > 0)) {
      showToast("Введите цену и количество");
      return;
    }

    try {
      const rpc =
        orderType === "MARKET"
          ? "open_terminal_market_position"
          : "create_terminal_limit_order";

      const params =
        orderType === "MARKET"
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
      $("orderPercent").value = "0";
      showToast(
        orderType === "MARKET"
          ? "Позиция открыта"
          : "Лимитный ордер создан"
      );

      await loadWalletAndAccountData();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось создать ордер");
    }
  }

  async function processLimitOrders() {
    const matching = state.orders.filter((order) => {
      if (order.symbol !== currentSymbol || order.status !== "open") return false;

      const limitPrice = Number(order.price);
      return order.side === "LONG"
        ? currentPrice <= limitPrice
        : currentPrice >= limitPrice;
    });

    for (const order of matching) {
      const { error } = await supabaseClient.rpc(
        "fill_terminal_limit_order",
        {
          p_order_id: order.id,
          p_fill_price: currentPrice,
        }
      );

      if (!error) {
        showToast(`${order.symbol}: лимитный ордер исполнен`);
      }
    }

    if (matching.length) {
      await loadWalletAndAccountData();
    }
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

      return {
        ...position,
        current_price: currentPrice,
        live_pnl: pnl,
      };
    });

    renderPositions();
  }

  function renderPositions() {
    $("positionsCount").textContent = `(${state.positions.length})`;

    $("positionsBody").innerHTML = state.positions.length
      ? state.positions.map((position) => {
          const livePrice =
            Number(position.current_price) ||
            (position.symbol === currentSymbol ? currentPrice : Number(position.entry_price));

          const pnl =
            Number.isFinite(Number(position.live_pnl))
              ? Number(position.live_pnl)
              : position.side === "LONG"
                ? (livePrice - Number(position.entry_price)) * Number(position.quantity)
                : (Number(position.entry_price) - livePrice) * Number(position.quantity);

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
                <button data-close-position="${position.id}">Закрыть</button>
              </td>
            </tr>
          `;
        }).join("")
      : '<tr><td colspan="8" class="empty-row">Открытых позиций нет</td></tr>';

    document.querySelectorAll("[data-close-position]").forEach((button) => {
      button.onclick = () => closePosition(button.dataset.closePosition);
    });
  }

  function renderOrders() {
    $("ordersCount").textContent = `(${state.orders.length})`;

    $("ordersBody").innerHTML = state.orders.length
      ? state.orders.map((order) => `
          <tr>
            <td><strong>${escapeHtml(order.symbol)}</strong></td>
            <td class="${order.side === "LONG" ? "positive" : "negative"}">
              ${escapeHtml(order.side)}
            </td>
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
            <td class="${trade.side === "LONG" ? "positive" : "negative"}">
              ${escapeHtml(trade.side)}
            </td>
            <td>${formatPrice(trade.entry_price)}</td>
            <td>${formatPrice(trade.exit_price)}</td>
            <td>${formatNumber(trade.quantity)}</td>
            <td class="${Number(trade.pnl) >= 0 ? "positive" : "negative"}">
              ${Number(trade.pnl) >= 0 ? "+" : ""}${Number(trade.pnl).toFixed(2)} USDT
            </td>
            <td class="${Number(trade.pnl_percent) >= 0 ? "positive" : "negative"}">
              ${Number(trade.pnl_percent) >= 0 ? "+" : ""}${Number(trade.pnl_percent).toFixed(2)}%
            </td>
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
      await loadWalletAndAccountData();
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
      await loadWalletAndAccountData();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось отменить ордер");
    }
  }

  function isMobileTerminal() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function resizeChartToContainer() {
    if (!chart) return;

    const container = $("terminalChart");

    requestAnimationFrame(() => {
      chart.resize(
        Math.max(container.clientWidth, 320),
        Math.max(container.clientHeight, 300)
      );

      chart.timeScale().fitContent();
      chart.timeScale().applyOptions({ rightOffset: 18 });
      resizeDrawingCanvas();
      renderDrawings();
    });
  }

  function openMobileChart() {
    if (!isMobileTerminal()) return;

    document.body.classList.add("mobile-chart-open");

    $("mobileTerminalHomeButton")?.classList.remove("active");
    $("mobileOpenChartButton")?.classList.add("active");

    if ($("mobileChartSymbol")) {
      $("mobileChartSymbol").textContent = currentSymbol;
    }

    resizeChartToContainer();
  }

  function closeMobileChart() {
    document.body.classList.remove("mobile-chart-open");

    $("mobileOpenChartButton")?.classList.remove("active");
    $("mobileTerminalHomeButton")?.classList.add("active");
  }

  function bindEvents() {
    document.querySelectorAll("[data-drawing-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        setDrawingTool(button.dataset.drawingTool);
      });
    });

    document.querySelector('[data-drawing-action="undo"]')?.addEventListener(
      "click",
      undoDrawing
    );

    document.querySelector('[data-drawing-action="clear"]')?.addEventListener(
      "click",
      clearDrawings
    );

    $("drawingCanvas")?.addEventListener("pointerdown", beginDrawing);
    $("drawingCanvas")?.addEventListener("pointermove", moveDrawing);
    $("drawingCanvas")?.addEventListener("pointerup", finishDrawing);
    $("drawingCanvas")?.addEventListener("pointercancel", finishDrawing);

    $("toggleVolumeButton")?.addEventListener("click", () => {
      volumeVisible = !volumeVisible;
      volumeSeries?.applyOptions({ visible: volumeVisible });
      $("toggleVolumeButton").classList.toggle("active", volumeVisible);
    });

    $("resetChartButton")?.addEventListener("click", () => {
      chart.timeScale().fitContent();
      chart.timeScale().applyOptions({ rightOffset: 18 });
      renderDrawings();
    });

    $("desktopTerminalHomeButton")?.addEventListener("click", () => {
      try {
        if (
          window.parent &&
          window.parent !== window &&
          typeof window.parent.openSection === "function"
        ) {
          window.parent.openSection("overview");
          return;
        }
      } catch (error) {
        console.warn("Direct dashboard navigation unavailable:", error);
      }

      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: "FASTBOOT_OPEN_SECTION", section: "overview" },
            window.location.origin
          );

          window.setTimeout(() => {
            try {
              window.top.location.href = "dashboard.html";
            } catch {
              window.location.href = "dashboard.html";
            }
          }, 250);

          return;
        }
      } catch (error) {
        console.warn("Dashboard message navigation unavailable:", error);
      }

      window.location.href = "dashboard.html";
    });

    $("mobileOpenChartButton")?.addEventListener("click", openMobileChart);
    $("mobileChartHomeButton")?.addEventListener("click", closeMobileChart);
    $("mobileTerminalHomeButton")?.addEventListener("click", closeMobileChart);

    window.addEventListener("resize", () => {
      if (!isMobileTerminal()) {
        closeMobileChart();
      }

      resizeChartToContainer();
    });

    $("symbolSelect").onchange = async (event) => {
      currentSymbol = event.target.value;
      $("baseAssetLabel").textContent = currentSymbol.replace("USDT", "");

      if ($("mobileChartSymbol")) {
        $("mobileChartSymbol").textContent = currentSymbol;
      }

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

    document.querySelectorAll("[data-order-type]").forEach((button) => {
      button.onclick = () => {
        document.querySelectorAll("[data-order-type]").forEach((item) =>
          item.classList.toggle("active", item === button)
        );

        const market = button.dataset.orderType === "MARKET";
        $("priceField").hidden = market;

        if (market) {
          $("orderPrice").value = currentPrice;
        }

        updateOrderCalculation();
      };
    });

    document.querySelectorAll("[data-bottom-tab]").forEach((button) => {
      button.onclick = () => {
        document.querySelectorAll("[data-bottom-tab]").forEach((item) =>
          item.classList.toggle("active", item === button)
        );

        document.querySelectorAll(".bottom-tab-content").forEach((panel) =>
          panel.classList.toggle(
            "active",
            panel.id === `${button.dataset.bottomTab}Tab`
          )
        );
      };
    });

    $("refreshChartButton").onclick = loadMarket;
    $("depthPrecision").onchange = loadMarket;
    $("orderPrice").oninput = updateOrderCalculation;
    $("orderQuantity").oninput = updateOrderCalculation;
    $("orderPercent").oninput = (event) =>
      setQuantityFromPercent(event.target.value);

    $("buyButton").onclick = () => placeOrder("LONG");
    $("sellButton").onclick = () => placeOrder("SHORT");

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
        await loadWalletAndAccountData();
      } catch (error) {
        console.error(error);
        showToast(error.message || "Не удалось выполнить перевод");
      }
    };

    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === "FASTBOOT_TERMINAL_REFRESH") {
        loadWalletAndAccountData().catch(console.error);
      }
    });
  }

  async function refreshLoop() {
    try {
      await loadMarket();

      // Wallet and DB data less frequently than market.
      if (!refreshLoop.counter || refreshLoop.counter % 3 === 0) {
        await loadWalletAndAccountData();
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

      if ($("mobileChartSymbol")) {
        $("mobileChartSymbol").textContent = currentSymbol;
      }

      await loadMarket();

      try {
        await loadWalletAndAccountData();
      } catch (accountError) {
        console.error("Terminal account data error:", accountError);
        showToast("График работает, но торговый счёт временно недоступен");
      }

      refreshTimer = setInterval(refreshLoop, REFRESH_MS);
    } catch (error) {
      console.error(error);
      showToast(error.message || "Не удалось запустить терминал");
    }
  }

  start();
})();
