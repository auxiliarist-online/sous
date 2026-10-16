"""Error reporting with PostHog (TYL-74): unhandled errors in the API reach
the team during the beta, next to the web app's. Off unless POSTHOG_KEY is
set. Only the error, the route and the method are sent: never a request's
query, body, headers or cookies (they can hold the user's recipes, photos
and tokens)."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from posthog import Posthog

from app.config import settings

HOST = "https://us.i.posthog.com"


def reporter(key: str | None = None) -> Posthog | None:
    """A PostHog client if a key is configured. It sends each error before
    the request ends: a serverless function may stop right after."""
    key = settings.posthog_key if key is None else key
    if not key:
        return None
    return Posthog(key, host=HOST, sync_mode=True)


def report_errors(app: FastAPI, client: Posthog | None) -> None:
    """Report the API's unhandled errors (a plain 500 still goes back)."""
    if client is None:
        return

    @app.middleware("http")
    async def capture(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        """Pass the request on; report an error that escapes it."""
        try:
            return await call_next(request)
        except Exception as exc:
            client.capture_exception(
                exc,
                distinct_id="sous-api",
                properties={"route": request.url.path, "method": request.method},
            )
            return JSONResponse({"detail": "Internal Server Error"}, status_code=500)
