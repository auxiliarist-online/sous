from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """The API's settings, from the environment (and .env when running locally)."""

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
    # Google Cloud Vision: reading recipes from photos of cookbook pages (TYL-52).
    google_vision_api_key: str = ""
    # Pages read from photos, at most: a month for everyone (Vision's free
    # tier is 1,000), and a day per user.
    photo_pages_per_month: int = 900
    photo_pages_per_day: int = 40
    # PostHog error reporting (TYL-74); off when empty.
    posthog_key: str = ""
    # Filing beta testers' problem reports in Linear: a personal API key (off
    # when empty), and where they go: the Sous project, labelled Bug.
    linear_api_key: str = ""
    linear_team_id: str = "1b5a5b93-5634-4708-85b1-a849bc9a8598"
    linear_project_id: str = "a840f31f-21f4-4474-9dbd-a3031076fb67"
    linear_bug_label_id: str = "2e0f1a4a-7cd0-4b78-8e00-88f6c20f8f3f"


settings = Settings()
