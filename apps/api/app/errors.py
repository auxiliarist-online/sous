"""Error reporting with Sentry (TYL-74): unhandled errors in the API reach
the team during the beta. Off unless SENTRY_DSN is set."""

import os
from typing import Any

import sentry_sdk

from app.config import settings


def scrub(event: Any, hint: Any) -> Any:
    """Strip what a request can carry about the user before an event is sent:
    the query string (search terms), body, cookies and headers, and any query
    left on the URL."""
    request = event.get("request")
    if isinstance(request, dict):
        for key in ("query_string", "data", "cookies", "headers"):
            request.pop(key, None)
        if isinstance(request.get("url"), str):
            request["url"] = request["url"].split("?", 1)[0]
    return event


def start_error_reporting(dsn: str | None = None) -> bool:
    """Start Sentry if a DSN is configured; returns whether it started.

    No personal data: no IP addresses, cookies or headers, no request bodies
    (they can hold photos of cookbook pages and the user's recipes), and no
    local variables in stack traces (they can hold tokens and recipe text).
    """
    dsn = settings.sentry_dsn if dsn is None else dsn
    if not dsn:
        return False
    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("VERCEL_ENV", "development"),
        send_default_pii=False,
        max_request_body_size="never",
        include_local_variables=False,
        before_send=scrub,
        traces_sample_rate=0,
    )
    return True
