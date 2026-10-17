"""Error reporting with PostHog (TYL-74): unhandled errors in the API reach
the team during the beta, next to the web app's. Off unless POSTHOG_KEY is
set. Only what kind of error it was, where in the code, the route and the
method are sent: never its message (an upstream error can echo what the user
sent), nor a request's query, body, headers or cookies, nor local variables."""

import asyncio
import functools
import logging
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from posthog import Posthog

from app.config import settings

HOST = "https://us.i.posthog.com"
# How long a report may take before the error response goes back anyway.
REPORT_SECONDS = 3.0

log = logging.getLogger(__name__)
# Reports are sent from threads of their own, so a stalled upload holds up
# neither the event loop nor its shutdown.
_senders = ThreadPoolExecutor(max_workers=2, thread_name_prefix="posthog-report")


class ApiError(Exception):
    """What PostHog gets in place of an error: its type, and its traceback
    (where in the code), without its message."""


def reporter(key: str | None = None) -> Posthog | None:
    """A PostHog client if a key is configured. It sends each report as it's
    made (a serverless function may stop right after), never with variables."""
    key = settings.posthog_key if key is None else key
    if not key:
        return None
    return Posthog(
        key, host=HOST, sync_mode=True, timeout=2, capture_exception_code_variables=False
    )


def safe(exc: BaseException) -> ApiError:
    """The error as it's reported: named by its type, with its traceback."""
    kind = type(exc)
    return ApiError(f"{kind.__module__}.{kind.__qualname__}").with_traceback(exc.__traceback__)


def report_errors(app: FastAPI, client: Posthog | None) -> None:
    """Report the API's unhandled errors. The report is made from Starlette's
    own 500 handler, so the error is still logged and re-raised as usual,
    and in a thread with a time limit, so a slow upload holds up nothing."""
    if client is None:
        return

    async def report(request: Request, exc: Exception) -> Response:
        """Send the report (giving up after a few seconds), then a plain 500."""
        try:
            send = functools.partial(
                client.capture_exception,
                safe(exc),
                distinct_id="sous-api",
                properties={"route": request.url.path, "method": request.method},
            )
            await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(_senders, send), REPORT_SECONDS
            )
        except Exception:
            log.warning("couldn't report an error to PostHog", exc_info=True)
        return JSONResponse({"detail": "Internal Server Error"}, status_code=500)

    app.add_exception_handler(Exception, report)
