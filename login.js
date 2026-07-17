"use strict";

const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("loginEmail");
const passwordInput = document.getElementById("loginPassword");
const messageElement = document.getElementById("authError");
const submitButton = loginForm?.querySelector('button[type="submit"]');

let redirectStarted = false;

function showMessage(message, type = "error") {
  if (!messageElement) return;
  messageElement.textContent = message;
  messageElement.style.display = message ? "block" : "none";
  messageElement.style.color = type === "success" ? "#20c987" : "#ff5f78";
}

function setLoading(loading) {
  if (!submitButton) return;
  submitButton.disabled = loading;
  submitButton.textContent = loading ? "Выполняется вход..." : "Войти";
}

function goToDashboard() {
  if (redirectStarted) return;
  redirectStarted = true;
  window.location.replace("dashboard.html");
}

function translateError(error) {
  const message = error?.message || "";

  if (message === "Email not confirmed") {
    return "Сначала подтвердите email через письмо.";
  }

  if (
    message === "Invalid login credentials" ||
    message === "Invalid email or password"
  ) {
    return "Неверный email или пароль.";
  }

  return message || "Не удалось выполнить вход.";
}

async function checkSession() {
  const client = window.fastbootSupabase;

  if (!client) {
    showMessage("Не удалось подключиться к Supabase. Проверьте supabase-config.js.");
    return;
  }

  try {
    const {
      data: { session },
      error,
    } = await client.auth.getSession();

    if (error) {
      console.error("Ошибка проверки сессии:", error);
      return;
    }

    if (session?.user) {
      goToDashboard();
    }
  } catch (error) {
    console.error("Ошибка проверки сессии:", error);
  }
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");

  const client = window.fastbootSupabase;

  if (!client) {
    showMessage("Supabase не подключён.");
    return;
  }

  const email = emailInput?.value.trim().toLowerCase() || "";
  const password = passwordInput?.value || "";

  if (!email || !password) {
    showMessage("Введите email и пароль.");
    return;
  }

  setLoading(true);

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    if (!data.session?.user) throw new Error("Сессия не создана.");

    showMessage("Вход выполнен. Открываем кабинет...", "success");
    goToDashboard();
  } catch (error) {
    console.error("Ошибка входа:", error);
    showMessage(translateError(error));
  } finally {
    setLoading(false);
  }
});

checkSession();
