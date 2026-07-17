const SUPABASE_URL = "https://vsfwbygmywhzkuiptulc.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_yVxw8Ipx2s8YLB2b3aCjqw_K0wLTSlU";

window.fastbootSupabase = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
