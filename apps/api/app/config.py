from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str = ""
    supabase_service_role_key: str = ""
    # Page explaining SousBot and how to opt out; sent in the User-Agent (TYL-27).
    sousbot_contact_url: str = ""
    # Minimum seconds between requests to the same site.
    fetch_interval_seconds: float = 5.0


settings = Settings()
