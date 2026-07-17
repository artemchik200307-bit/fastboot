"use strict";

const registerForm = document.getElementById("registerForm");
const usernameInput = document.getElementById("registerName");
const emailInput = document.getElementById("registerEmail");
const passwordInput = document.getElementById("registerPassword");
const repeatPasswordInput = document.getElementById("registerPasswordRepeat");
const messageElement = document.getElementById("authError");
const submitButton = registerForm?.querySelector('button[type="submit"]');

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
  submitButton.textContent = loading ? "Создание аккаунта..." : "Создать аккаунт";
}

function goToDashboard() {
  if (redirectStarted) return;
  redirectStarted = true;
  window.location.replace("dashboard.html");
}

function translateError(error) {
  const message = error?.message || "";

  const map = {
    "User already registered": "Пользователь с таким email уже зарегистрирован.",
    "Password should be at least 6 characters": "Пароль слишком короткий.",
    "Unable to validate email address: invalid format": "Введите правильный email.",
    "Signup is disabled": "Регистрация новых пользователей отключена.",
  };

  if (map[message]) return map[message];
  if (message.toLowerCase().includes("duplicate key")) {
    return "Такое имя пользователя уже занято.";
  }

  return message || "Не удалось создать аккаунт.";
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

registerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");

  const client = window.fastbootSupabase;

  if (!client) {
    showMessage("Supabase не подключён.");
    return;
  }

  const username = usernameInput?.value.trim() || "";
  const email = emailInput?.value.trim().toLowerCase() || "";
  const password = passwordInput?.value || "";
  const repeatedPassword = repeatPasswordInput?.value || "";

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    showMessage("Имя: 3–24 латинские буквы, цифры или _.");
    return;
  }

  if (password.length < 8) {
    showMessage("Пароль должен содержать минимум 8 символов.");
    return;
  }

  if (password !== repeatedPassword) {
    showMessage("Пароли не совпадают.");
    return;
  }

  setLoading(true);

  try {
    const redirectUrl = new URL("dashboard.html", window.location.href).href;

    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: redirectUrl,
      },
    });

    if (error) throw error;

    if (data.session?.user) {
      showMessage("Аккаунт создан. Открываем кабинет...", "success");
      goToDashboard();
      return;
    }

    showMessage(
      "Аккаунт создан. Подтвердите email через письмо, затем войдите.",
      "success"
    );
    registerForm.reset();
  } catch (error) {
    console.error("Ошибка регистрации:", error);
    showMessage(translateError(error));
  } finally {
    setLoading(false);
  }
});

checkSession();
