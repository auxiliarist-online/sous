"""Error reporting with Sentry (TYL-74): unhandled errors in the API reach
the team during the beta. Off unless SENTRY_DSN is set."""

import os

import sentry_sdk

from app.config import settings


def start_error_reporting(dsn: str | None = None) -> bool:
    """Start Sentry if a DSN is configured; returns whether it started.

    No personal data: no IP addresses, cookies or headers, and no request
    bodies (they can hold photos of cookbook pages and the user's recipes).
    """
    dsn = settings.sentry_dsn if dsn is None else dsn
    if not dsn:
        return False
    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("VERCEL_ENV", "development"),
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=0,
    )
    return True
