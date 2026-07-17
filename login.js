"use strict";

const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("loginEmail");
const passwordInput = document.getElementById("loginPassword");
const messageElement = document.getElementById("authError");
const submitButton = loginForm?.querySelector('button[type="submit"]');

function showMessage(message, type = "error") {
  if (!messageElement) return;

  messageElement.textContent = message;
  messageElement.style.display = "block";
  messageElement.style.color =
    type === "success" ? "#20c987" : "#ff5f78";
}

function setLoading(isLoading) {
  if (!submitButton) return;

  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Выполняется вход..." : "Войти";
}

async function checkExistingSession() {
  if (!window.fastbootSupabase) {
    showMessage("Не удалось подключиться к Supabase.");
    return;
  }

  const {
    data: { session },
  } = await window.fastbootSupabase.auth.getSession();

  if (session) {
    window.location.replace("dashboard.html");
  }
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!window.fastbootSupabase) {
    showMessage("Supabase не подключён.");
    return;
  }

  const email = emailInput?.value.trim().toLowerCase();
  const password = passwordInput?.value;

  if (!email || !password) {
    showMessage("Введите email и пароль.");
    return;
  }

  setLoading(true);

  try {
    const { data, error } =
      await window.fastbootSupabase.auth.signInWithPassword({
        email,
        password,
      });

    if (error) {
      throw error;
    }

    if (!data.session) {
      throw new Error("Сессия не была создана.");
    }

    showMessage("Вход выполнен. Открываем кабинет...", "success");

    setTimeout(() => {
      window.location.replace("dashboard.html");
    }, 500);
  } catch (error) {
    console.error("Ошибка входа:", error);

    if (error.message === "Email not confirmed") {
      showMessage("Сначала подтвердите email через письмо.");
    } else {
      showMessage(
        "Не удалось войти. Проверьте email и пароль."
      );
    }
  } finally {
    setLoading(false);
  }
});

checkExistingSession();
