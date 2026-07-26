from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str
    scan_interval_minutes: int = 30
    scan_concurrency: int = 4
    minimum_signal_confidence: float = 55.0
    auto_minimum_signal_confidence: float = 60.0
    auto_risk_fraction: float = 0.001
    auto_daily_target_fraction: float = 0.01
    auto_leverage: int = 3
    auto_monitor_seconds: int = 5

    model_config = SettingsConfigDict(
        env_file=".env", case_sensitive=False, extra="ignore"
    )


settings = Settings()
