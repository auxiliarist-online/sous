"""Filing beta testers' problem reports in Linear.

The app saves a report itself (row-level security keeps it the user's own),
then asks here for it to be filed: this reads it with the service role,
creates a Linear issue in the Sous project, labelled Bug, with the device and
a link to the PostHog replay, and records the issue's link on the report. The
reporter is named by their account id, never their email.
"""

from typing import Annotated, Any

import httpx2 as httpx
from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import current_user_id
from app.config import settings

router = APIRouter(prefix="/feedback", tags=["feedback"])

LINEAR_URL = "https://api.linear.app/graphql"
CREATE_ISSUE = """
mutation File($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}
"""


# Marks a report one request is filing right now.
FILING = "filing"


def _filed(url: str) -> dict[str, Any]:
    """The answer for a report filed (or being filed) already."""
    return {"filed": True, "url": None if url == FILING else url}


def _headers() -> dict[str, str]:
    """The service role's headers for Supabase's REST API."""
    key = settings.supabase_service_role_key
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def issue_for(report: dict[str, Any]) -> dict[str, Any]:
    """The Linear issue for a report: its first words as the title; the
    message, page, device, replay and who sent it (by account id) below."""
    message = report["message"].strip()
    first = message.splitlines()[0]
    title = first if len(first) <= 70 else first[:67].rstrip() + "…"
    quoted = "\n".join(f"> {line}" for line in message.splitlines())
    replay = f"[Watch the replay]({report['replay_url']})" if report.get("replay_url") else "none"
    description = "\n".join(
        [
            quoted,
            "",
            f"- **Page:** `{report.get('page') or '?'}`",
            f"- **Device:** {report.get('device') or '?'}",
            f"- **Replay:** {replay}",
            f"- **Reporter:** account `{report['user_id']}`",
            f"- **Sent:** {report['created_at']} (feedback #{report['id']})",
            "",
            "Filed from Sous's in-app problem report.",
        ]
    )
    return {
        "title": f"Beta report: {title}",
        "description": description,
        "teamId": settings.linear_team_id,
        "projectId": settings.linear_project_id,
        "labelIds": [settings.linear_bug_label_id],
    }


@router.post("/{report_id}/file")
async def file(report_id: int, user_id: Annotated[str, Depends(current_user_id)]) -> dict[str, Any]:
    """File the user's problem report in Linear, once. Without a Linear key
    the report stays saved, unfiled."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{settings.supabase_url}/rest/v1/feedback",
            params={
                "select": "id,user_id,kind,message,page,device,replay_url,linear_url,created_at",
                "id": f"eq.{report_id}",
            },
            headers=_headers(),
        )
        if resp.status_code != 200:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't load the report.")
        rows = resp.json()
        if not rows or rows[0]["user_id"] != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such report.")
        report = rows[0]
        if report["kind"] != "problem":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only problems are filed.")
        if report["linear_url"]:
            return _filed(report["linear_url"])
        if not settings.linear_api_key:
            return {"filed": False}

        # Claim it first, in one step: of two requests at once (a double tap,
        # a retry), only one gets the report, so it's filed once.
        claim = await client.patch(
            f"{settings.supabase_url}/rest/v1/feedback",
            params={"id": f"eq.{report_id}", "linear_url": "is.null", "select": "id"},
            json={"linear_url": FILING},
            headers={**_headers(), "Prefer": "return=representation"},
        )
        if claim.status_code != 200:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't file the report.")
        if not claim.json():
            return {"filed": True, "url": None}  # another request is filing it

        try:
            url = await _create_issue(client, report)
        except Exception as exc:
            # Whatever went wrong (Linear down, a timeout, an odd answer), let
            # the report go back, so a later try can file it.
            await client.patch(
                f"{settings.supabase_url}/rest/v1/feedback",
                params={"id": f"eq.{report_id}", "linear_url": f"eq.{FILING}"},
                json={"linear_url": None},
                headers=_headers(),
            )
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "We couldn't file the report."
            ) from exc
        # The issue exists now: if recording its link fails, the report stays
        # marked as filing, and isn't filed twice.
        await client.patch(
            f"{settings.supabase_url}/rest/v1/feedback",
            params={"id": f"eq.{report_id}"},
            json={"linear_url": url},
            headers=_headers(),
        )
    return {"filed": True, "url": url}


async def _create_issue(client: httpx.AsyncClient, report: dict[str, Any]) -> str:
    """Create the report's Linear issue; its link. Raises if Linear says no."""
    resp = await client.post(
        LINEAR_URL,
        json={"query": CREATE_ISSUE, "variables": {"input": issue_for(report)}},
        # Linear's personal keys go as they are, without "Bearer".
        headers={"Authorization": settings.linear_api_key},
    )
    resp.raise_for_status()
    created = (resp.json().get("data") or {}).get("issueCreate") or {}
    if not created.get("success"):
        raise RuntimeError("Linear didn't create the issue")
    return str(created["issue"]["url"])
