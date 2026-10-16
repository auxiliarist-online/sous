"""Print what beta testers sent with the in-app feedback form, newest first.

    .venv/bin/python scripts/read_feedback.py            # the last 14 days
    .venv/bin/python scripts/read_feedback.py --days 60

Each message shows when it was sent, by whom (their sign-in email) and the
page they were on. Read-only. Needs the service role in .env.
"""

import argparse
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2 as httpx

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

from app.config import settings  # noqa: E402


def emails(auth: httpx.Client, user_ids: set[str]) -> dict[str, str]:
    """Each user's sign-in email, from Supabase Auth (one call per user)."""
    out = {}
    for uid in user_ids:
        r = auth.get(f"/admin/users/{uid}")
        email = r.json().get("email") if r.is_success else None
        out[uid] = email or uid
    return out


def describe(row: dict[str, Any], who: str) -> str:
    """One message as printed: a header line, then the message indented."""
    sent = datetime.fromisoformat(row["created_at"]).astimezone().strftime("%Y-%m-%d %H:%M")
    body = "\n".join(f"    {line}" for line in row["message"].splitlines())
    return f"{sent}  {who}  {row['page'] or ''}\n{body}\n"


def main() -> None:
    """Fetch the feedback and print it."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--days", type=int, default=14)
    args = parser.parse_args()

    key = settings.supabase_service_role_key
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    since = (datetime.now(UTC) - timedelta(days=args.days)).isoformat()
    with (
        httpx.Client(base_url=f"{settings.supabase_url}/rest/v1", headers=headers) as db,
        httpx.Client(base_url=f"{settings.supabase_url}/auth/v1", headers=headers) as auth,
    ):
        r = db.get(
            "/feedback",
            params={
                "select": "user_id,message,page,created_at",
                "created_at": f"gte.{since}",
                "order": "created_at.desc",
            },
        )
        r.raise_for_status()
        rows: list[dict[str, Any]] = r.json()
        who = emails(auth, {row["user_id"] for row in rows})
    if not rows:
        print(f"No feedback in the last {args.days} days.")
    for row in rows:
        print(describe(row, who[row["user_id"]]))


if __name__ == "__main__":
    main()
