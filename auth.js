const ADMIN_ACCOUNT = {
  id: "FB-ADMIN-0001",
  name: "Administrator",
  email: "admin@fastboot.local",
  password: "FastbootAdmin2026!",
  role: "admin",
};

function getUsers() {
  try {
    return JSON.parse(localStorage.getItem("fastboot-users") || "[]");
  } catch {
    return [];
  }
}

function saveUsers(users) {
  localStorage.setItem("fastboot-users", JSON.stringify(users));
}

function ensureAdmin() {
  const users = getUsers();
  if (!users.some((user) => user.email === ADMIN_ACCOUNT.email)) {
    users.push(ADMIN_ACCOUNT);
    saveUsers(users);
  }
}

function createId() {
  return `FB-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36).slice(2, 7).toUpperCase()}`;
}

function setSession(user) {
  const safeUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
  };
  localStorage.setItem("fastboot-session", JSON.stringify(safeUser));
}

function showError(message) {
  const element = document.getElementById("authError");
  if (element) element.textContent = message;
}

ensureAdmin();

document.getElementById("loginForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;

  const user = getUsers().find(
    (item) => item.email.toLowerCase() === email && item.password === password
  );

  if (!user) {
    showError("Неверный email или пароль.");
    return;
  }

  setSession(user);
  window.location.href = "dashboard.html";
});

document.getElementById("registerForm")?.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = document.getElementById("registerName").value.trim();
  const email = document.getElementById("registerEmail").value.trim().toLowerCase();
  const password = document.getElementById("registerPassword").value;
  const repeat = document.getElementById("registerPasswordRepeat").value;

  if (password !== repeat) {
    showError("Пароли не совпадают.");
    return;
  }

  const users = getUsers();

  if (users.some((user) => user.email.toLowerCase() === email)) {
    showError("Аккаунт с таким email уже существует.");
    return;
  }

  const user = {
    id: createId(),
    name,
    email,
    password,
    role: "user",
  };

  users.push(user);
  saveUsers(users);
  setSession(user);
  window.location.href = "dashboard.html";
});
