"use strict";

const registerForm = document.getElementById("registerForm");
const usernameInput = document.getElementById("registerName");
const emailInput = document.getElementById("registerEmail");
const passwordInput = document.getElementById("registerPassword");
const repeatPasswordInput = document.getElementById(
  "registerPasswordRepeat"
);
const messageElement = document.getElementById("authError");
const submitButton = registerForm?.querySelector(
  'button[type="submit"]'
);

function showMessage(message, type = "error") {
  messageElement.textContent = message;
  messageElement.style.display = "block";
  messageElement.style.color =
    type === "success" ? "#20c987" : "#ff5f78";
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.textContent = loading
    ? "Создание аккаунта..."
    : "Создать аккаунт";
}

function translateAuthError(message) {
  const errors = {
    "User already registered":
      "Пользователь с таким email уже зарегистрирован.",
    "Password should be at least 6 characters":
      "Пароль слишком короткий.",
    "Unable to validate email address: invalid format":
      "Введите правильный адрес электронной почты.",
    "Signup is disabled":
      "Регистрация новых пользователей временно отключена.",
  };

  return errors[message] || message || "Не удалось создать аккаунт.";
}

async function redirectAuthenticatedUser() {
  if (!window.fastbootSupabase) {
    showMessage(
      "Не удалось подключиться к Supabase. Проверьте файл supabase-config.js."
    );
    return;
  }

  const {
    data: { session },
  } = await window.fastbootSupabase.auth.getSession();

  if (session) {
    window.location.replace("dashboard.html");
  }
}

registerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  messageElement.textContent = "";

  if (!window.fastbootSupabase) {
    showMessage("Supabase не подключён.");
    return;
  }

  const username = usernameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const repeatedPassword = repeatPasswordInput.value;

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    showMessage(
      "Имя должно содержать от 3 до 24 латинских букв, цифр или символов _. "
    );
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
    const { data, error } =
      await window.fastbootSupabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            username,
          },
          emailRedirectTo: new URL(
            "dashboard.html",
            window.location.href
          ).href,
        },
      });

    if (error) {
      throw error;
    }

    if (data.session) {
      showMessage(
        "Аккаунт успешно создан. Открываем личный кабинет...",
        "success"
      );

      setTimeout(() => {
        window.location.replace("dashboard.html");
      }, 700);

      return;
    }

    showMessage(
      "Аккаунт создан. Проверьте почту и подтвердите регистрацию.",
      "success"
    );

    registerForm.reset();
  } catch (error) {
    console.error("Ошибка регистрации:", error);
    showMessage(translateAuthError(error.message));
  } finally {
    setLoading(false);
  }
});

redirectAuthenticatedUser();
