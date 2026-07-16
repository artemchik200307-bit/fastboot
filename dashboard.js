const sectionTitles = {
  overview: "Обзор",
  assistant: "AI Assistant",
  "market-analysis": "Анализ рынка",
  news: "Анализ новостей",
  "smart-money": "Smart Money",
  risk: "Риск-менеджмент",
  favorites: "Избранное",
  journal: "Торговый журнал",
  history: "История анализов",
  settings: "Настройки",
};

const $ = (id) => document.getElementById(id);

function openSection(sectionId) {
  document.querySelectorAll(".dashboard-section").forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });

  document.querySelectorAll(".nav-item[data-section]").forEach((item) => {
    item.classList.toggle("active", item.dataset.section === sectionId);
  });

  $("pageTitle").textContent = sectionTitles[sectionId] || "FASTBOOT";
  $("sidebar").classList.remove("open");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-section]").forEach((button) => {
  button.addEventListener("click", () => {
    openSection(button.dataset.section);
  });
});

document.querySelectorAll("[data-open-section]").forEach((button) => {
  button.addEventListener("click", () => {
    openSection(button.dataset.openSection);
  });
});

$("menuButton").addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
});

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2300);
}

$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const input = $("chatInput");
  const text = input.value.trim();

  if (!text) return;

  $("chatHistory").insertAdjacentHTML(
    "beforeend",
    `
      <div class="chat-message user-message">
        <span>ВЫ</span>
        <p>${escapeHtml(text)}</p>
      </div>
      <div class="chat-message assistant-message">
        <span>FASTBOOT AI</span>
        <p>
          AI ещё не подключён. После подключения здесь появится настоящий ответ
          и анализ рынка.
        </p>
      </div>
    `
  );

  input.value = "";
  $("chatHistory").scrollTop = $("chatHistory").scrollHeight;
});

document.querySelectorAll(".prompt-button").forEach((button) => {
  button.addEventListener("click", () => {
    $("chatInput").value = button.textContent.trim();
    $("chatInput").focus();
  });
});

$("runAnalysisButton").addEventListener("click", () => {
  const symbol = $("analysisSymbol").value;
  const timeframe = $("analysisTimeframe").value;
  const type = $("analysisType").value;

  $("analysisResult").innerHTML = `
    <div class="empty-icon">✓</div>
    <strong>Запрос на анализ подготовлен</strong>
    <p>
      ${escapeHtml(symbol)} · ${escapeHtml(timeframe)} · ${escapeHtml(type)}.
      AI-модель подключим на следующем этапе.
    </p>
  `;

  showToast("Параметры анализа сохранены");
});

function calculateRisk() {
  const balance = Number($("balanceInput").value);
  const riskPercent = Number($("riskInput").value);
  const entry = Number($("entryInput").value);
  const stop = Number($("stopInput").value);

  const money = balance * (riskPercent / 100);
  $("riskMoney").textContent =
    Number.isFinite(money) ? `${money.toFixed(2)} USDT` : "—";

  const distance = Math.abs(entry - stop);

  if (entry > 0 && stop > 0 && distance > 0) {
    $("stopDistance").textContent = distance.toFixed(4);
    $("positionSize").textContent = `${(money / distance).toFixed(6)} монет`;
  } else {
    $("stopDistance").textContent = "—";
    $("positionSize").textContent = "—";
  }
}

["balanceInput", "riskInput", "entryInput", "stopInput"].forEach((id) => {
  $(id).addEventListener("input", calculateRisk);
});

document.querySelectorAll(".remove-favorite").forEach((button) => {
  button.addEventListener("click", () => {
    button.closest(".favorite-card")?.remove();

    const count = document.querySelectorAll(".favorite-card").length;
    $("favoriteCount").textContent = String(count);

    showToast("Монета удалена из избранного");
  });
});

$("addTradeButton").addEventListener("click", () => {
  $("tradeModal").classList.remove("hidden");
});

$("closeTradeModal").addEventListener("click", () => {
  $("tradeModal").classList.add("hidden");
});

$("saveTradeButton").addEventListener("click", () => {
  const symbol = $("tradeSymbol").value.trim().toUpperCase();
  const direction = $("tradeDirection").value;
  const risk = Number($("tradeRisk").value);
  const result = $("tradeResult").value;

  if (!symbol || !(risk > 0)) {
    showToast("Заполните инструмент и риск");
    return;
  }

  const entries = $("journalEntries");

  if (entries.querySelector(".empty-state")) {
    entries.innerHTML = "";
  }

  entries.insertAdjacentHTML(
    "afterbegin",
    `
      <div class="journal-row">
        <span>${new Date().toLocaleDateString("ru-RU")}</span>
        <strong>${escapeHtml(symbol)}</strong>
        <span>${escapeHtml(direction)}</span>
        <span>${risk.toFixed(1)}%</span>
        <span>${escapeHtml(result)}</span>
      </div>
    `
  );

  $("tradeModal").classList.add("hidden");
  showToast("Сделка добавлена в журнал");
});

$("saveSettingsButton").addEventListener("click", () => {
  const name = $("profileName").value.trim() || "Artem";
  const risk = Number($("defaultRisk").value) || 1;

  document.querySelector(".profile-copy strong").textContent = name;
  document.querySelector(".profile-avatar").textContent =
    name.charAt(0).toUpperCase();

  $("riskInput").value = String(risk);
  $("overviewRisk").textContent = `${risk}%`;
  calculateRisk();

  showToast("Настройки сохранены в демо-режиме");
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

calculateRisk();
