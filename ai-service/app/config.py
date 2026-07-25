from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str
    groq_api_key: str | None = None
    groq_model: str = "llama-3.3-70b-versatile"
    scan_interval_minutes: int = 10
    max_scan_symbols: int = 20
    full_analysis_candidates: int = 8

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
