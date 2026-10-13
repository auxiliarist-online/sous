from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str = ""
    supabase_service_role_key: str = ""
    # Page explaining SousBot and how to opt out; sent in the User-Agent (TYL-27).
    sousbot_contact_url: str = ""
    # Minimum seconds between requests to the same site.
    fetch_interval_seconds: float = 5.0
    # Kroger API (Harris Teeter products and prices, TYL-80).
    kroger_client_id: str = ""
    kroger_client_secret: str = ""
    # Whose prices to show users who haven't picked a store: during the beta,
    # the Harris Teeter at Village at Chestnut Street, Asheville.
    kroger_default_location_id: str = "09700348"


settings = Settings()
