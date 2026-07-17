"use strict";

(async function protectDashboard() {
  const client = window.fastbootSupabase;

  const redirectToLogin = () => {
    window.location.replace("login.html");
  };

  if (!client) {
    console.error("Supabase client не загружен.");
    redirectToLogin();
    return;
  }

  try {
    const {
      data: { session },
      error: sessionError,
    } = await client.auth.getSession();

    if (sessionError) throw sessionError;
    if (!session?.user) {
      redirectToLogin();
      return;
    }

    const user = session.user;

    const [
      { data: profile, error: profileError },
      { data: wallet, error: walletError },
    ] = await Promise.all([
      client
        .from("profiles")
        .select("id, username, email, fastboot_id, role, created_at")
        .eq("id", user.id)
        .maybeSingle(),

      client
        .from("wallets")
        .select("user_id, spot_balance, bot_balance, currency, created_at, updated_at")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    if (profileError) {
      console.error("Ошибка загрузки профиля:", profileError);
    }

    if (walletError) {
      console.error("Ошибка загрузки кошелька:", walletError);
    }

    window.fastbootSession = session;
    window.fastbootUser = user;
    window.fastbootProfile = profile
      ? {
          ...profile,
          role: String(profile.role || "user").toLowerCase(),
        }
      : {
      id: user.id,
      username:
        user.user_metadata?.username ||
        user.email?.split("@")[0] ||
        "user",
      email: user.email,
      fastboot_id:
        "FB-" + user.id.replaceAll("-", "").slice(0, 10).toUpperCase(),
      role: String(user.user_metadata?.role || "user").toLowerCase(),
      created_at: user.created_at,
    };

    window.fastbootWallet = wallet || {
      user_id: user.id,
      spot_balance: 0,
      bot_balance: 0,
      currency: "USDT",
    };

    document.documentElement.classList.add("auth-ready");

    if (window.fastbootProfile?.role === "admin") document.documentElement.classList.add("is-admin");

    const script = document.createElement("script");
    script.src = "dashboard.js?v=terminal-v2";
    script.async = false;

    script.onerror = () => {
      console.error("Не удалось загрузить dashboard.js.");
      document.body.style.visibility = "visible";
    };

    document.body.appendChild(script);
  } catch (error) {
    console.error("Ошибка авторизации Dashboard:", error);

    try {
      await client.auth.signOut({ scope: "local" });
    } catch {
      // Ignore recovery sign-out error.
    }

    redirectToLogin();
  }
})();
