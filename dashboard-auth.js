"use strict";

(async function protectDashboard() {
  const client = window.fastbootSupabase;

  if (!client) {
    console.error("Supabase client не загружен");
    window.location.replace("login.html");
    return;
  }

  try {
    const {
      data: { session },
      error,
    } = await client.auth.getSession();

    if (error) {
      throw error;
    }

    if (!session) {
      window.location.replace("login.html");
      return;
    }

    window.fastbootSession = session;
    window.fastbootUser = session.user;

    document.documentElement.classList.add("auth-ready");
  } catch (error) {
    console.error("Ошибка проверки авторизации:", error);
    window.location.replace("login.html");
  }
})();
