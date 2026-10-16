"""Read a recipe from photos of a cookbook's pages (TYL-52).

Google Cloud Vision's document text detection reads each page into blocks,
paragraphs and words with their positions. From those, the text is put back
in reading order (a band across the page, then each column top to bottom) and
sorted into a draft: title, servings and times, ingredients (with sections)
and steps. The draft fills the manual-entry form for the user to check;
nothing is saved from here, and the photos aren't kept.

A cookbook page is its author's work: a recipe read from the user's own book
stays private to them, like one they type in (docs/policies/recipe-sources.md).
"""

import base64
import re
from dataclasses import dataclass, field
from typing import Any

import httpx2 as httpx

from app.config import settings

VISION_URL = "https://vision.googleapis.com/v1/images:annotate"
# Words Vision is less sure of than this make their line "check this".
UNSURE_BELOW = 0.8


class PhotoError(Exception):
    """Vision couldn't read the photos (not set up, or failing)."""


@dataclass
class Line:
    """One line of text on a page, as Vision read it."""

    text: str
    # Average word height on the page, in pixels: bigger text is a title.
    height: float = 0.0
    # The least sure word on the line (0-1).
    confidence: float = 1.0


@dataclass
class Block:
    """A block of text on a page, with its box (pixels) and its paragraphs,
    each a list of lines."""

    left: float
    top: float
    right: float
    bottom: float
    paragraphs: list[list[Line]] = field(default_factory=list)


@dataclass
class Draft:
    """A recipe read from photos, for the manual-entry form to show."""

    title: str = ""
    servings: float | None = None
    prep_minutes: int | None = None
    cook_minutes: int | None = None
    total_minutes: int | None = None
    # One per line; a line ending in ":" starts a section, as in the form.
    ingredients: list[str] = field(default_factory=list)
    instructions: list[str] = field(default_factory=list)
    # Lines to check: read with low confidence, or hard to place.
    unsure: list[str] = field(default_factory=list)
    # Text left out: the author's introduction, notes, page furniture.
    skipped: list[str] = field(default_factory=list)


async def record_read(user_id: str, pages: int) -> bool:
    """Count a read of `pages` pages against the limits (Vision's free tier
    for everyone, and a day's worth per user). False when it would pass one;
    nothing is counted then."""
    key = settings.supabase_service_role_key
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{settings.supabase_url}/rest/v1/rpc/record_photo_read",
                headers={"apikey": key, "Authorization": f"Bearer {key}"},
                json={
                    "p_user": user_id,
                    "p_pages": pages,
                    "p_month_cap": settings.photo_pages_per_month,
                    "p_day_cap": settings.photo_pages_per_day,
                },
            )
    except httpx.HTTPError as exc:
        raise PhotoError(f"couldn't count the read: {exc}") from exc
    if resp.status_code != 200:
        raise PhotoError(f"record_photo_read failed: {resp.status_code} {resp.text[:300]}")
    return bool(resp.json())


async def read_pages(images: list[bytes]) -> list[list[Block]]:
    """Each photo's blocks, as Vision reads them. One request for all pages."""
    if not settings.google_vision_api_key:
        raise PhotoError("GOOGLE_VISION_API_KEY isn't set")
    body = {
        "requests": [
            {
                "image": {"content": base64.b64encode(img).decode()},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                "imageContext": {"languageHints": ["en"]},
            }
            for img in images
        ]
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # The key goes in a header, so it stays out of logged URLs.
            resp = await client.post(
                VISION_URL, json=body, headers={"x-goog-api-key": settings.google_vision_api_key}
            )
    except httpx.HTTPError as exc:
        raise PhotoError(f"Vision unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise PhotoError(f"Vision answered {resp.status_code}: {resp.text[:300]}")
    pages = []
    for r in resp.json().get("responses") or []:
        if r.get("error"):
            raise PhotoError(f"Vision couldn't read a page: {r['error'].get('message')}")
        pages.append(blocks_of(r.get("fullTextAnnotation") or {}))
    return pages


def _box(poly: dict[str, Any]) -> tuple[float, float, float, float]:
    """A Vision bounding polygon as (left, top, right, bottom)."""
    xs = [v.get("x", 0) for v in poly.get("vertices") or []] or [0]
    ys = [v.get("y", 0) for v in poly.get("vertices") or []] or [0]
    return min(xs), min(ys), max(xs), max(ys)


def blocks_of(annotation: dict[str, Any]) -> list[Block]:
    """Vision's fullTextAnnotation for one page, as blocks of paragraphs of
    lines, keeping its line breaks and each word's height and confidence."""
    blocks = []
    for page in annotation.get("pages") or []:
        for b in page.get("blocks") or []:
            if b.get("blockType", "TEXT") != "TEXT":
                continue
            left, top, right, bottom = _box(b.get("boundingBox") or {})
            block = Block(left, top, right, bottom)
            for p in b.get("paragraphs") or []:
                lines: list[Line] = []
                text, heights, confs = "", [], []
                for w in p.get("words") or []:
                    _, wt, _, wb = _box(w.get("boundingBox") or {})
                    heights.append(wb - wt)
                    confs.append(float(w.get("confidence", 1.0)))
                    for s in w.get("symbols") or []:
                        text += s.get("text", "")
                        brk = ((s.get("property") or {}).get("detectedBreak") or {}).get("type")
                        if brk in ("SPACE", "SURE_SPACE"):
                            text += " "
                        elif brk in ("EOL_SURE_SPACE", "LINE_BREAK", "HYPHEN"):
                            if brk == "HYPHEN":
                                text += "-"
                            lines.append(_line(text, heights, confs))
                            text, heights, confs = "", [], []
                if text.strip():
                    lines.append(_line(text, heights, confs))
                lines = [ln for ln in lines if ln.text]
                if lines:
                    block.paragraphs.append(lines)
            if block.paragraphs:
                blocks.append(block)
    return blocks


def _line(text: str, heights: list[float], confs: list[float]) -> Line:
    """A line from its text and its words' heights and confidences."""
    return Line(
        text=re.sub(r"\s+", " ", text).strip(),
        height=sum(heights) / len(heights) if heights else 0.0,
        confidence=min(confs) if confs else 1.0,
    )


def reading_order(blocks: list[Block]) -> list[Block]:
    """Blocks in the order a person reads them: top to bottom, and where the
    page splits into columns, the left column before the right. A block that
    spans most of the page's width ends a run of columns."""
    if not blocks:
        return []
    left = min(b.left for b in blocks)
    right = max(b.right for b in blocks)
    width = max(right - left, 1.0)
    middle = left + width / 2
    out: list[Block] = []
    columns: tuple[list[Block], list[Block]] = ([], [])

    def flush() -> None:
        """Put out the columns gathered so far: left, then right."""
        for col in columns:
            out.extend(sorted(col, key=lambda b: b.top))
            col.clear()

    for b in sorted(blocks, key=lambda b: b.top):
        if b.right - b.left > 0.6 * width:
            flush()
            out.append(b)
        else:
            columns[0 if (b.left + b.right) / 2 < middle else 1].append(b)
    flush()
    return out


QUANTITY = re.compile(
    r"^\s*(?:[-–•*▢☐□]\s*)?"
    r"(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞]"
    r"|(?:a|an|one|two|three|four|five|six|eight|twelve|half|a few|several|pinch|"
    r"dash|handful|large|small|medium|juice of|zest of)\b)",
    re.I,
)
SERVES = re.compile(r"\b(?:serves|servings|makes|yield|yields)\b\D{0,12}(\d+(?:\.\d+)?)", re.I)
_AMOUNT_OF_TIME = r"(?: time)?\b\D{0,6}(\d+)\s*(h|hr|hour|min)"
TIMES = {
    "prep": re.compile(r"\bprep(?:aration)?" + _AMOUNT_OF_TIME, re.I),
    "cook": re.compile(r"\b(?:cook(?:ing)?|bak(?:e|ing))" + _AMOUNT_OF_TIME, re.I),
    "total": re.compile(r"\b(?:total|ready in)" + _AMOUNT_OF_TIME, re.I),
}
INGREDIENTS_HEAD = re.compile(r"^(?:ingredients?|you(?:'|’)ll need|you will need)\s*:?$", re.I)
STEPS_HEAD = re.compile(
    r"^(?:method|directions?|instructions?|preparation|to make|steps?)\s*:?$", re.I
)
STEP_NUMBER = re.compile(r"^\s*(?:step\s*)?\d+[.)]\s+", re.I)
SECTION = re.compile(r"^(?:for the|for)\b.{1,40}$", re.I)


def _minutes(m: re.Match[str]) -> int:
    """Minutes from a time match: "1 hour" is 60."""
    n = int(m.group(1))
    return n * 60 if m.group(2).lower().startswith("h") else n


def _is_heading(text: str) -> bool:
    """A short line that names a part: "For the sauce:", "TO SERVE"."""
    words = text.split()
    if not words or len(words) > 6:
        return False
    return text.endswith(":") or (text.isupper() and len(text) > 2) or bool(SECTION.match(text))


def _ingredientish(text: str) -> bool:
    """A short line that starts with an amount: "2 tbsp olive oil". ("3. Add
    the lentils" is a step, though it starts with a number.)"""
    return (
        bool(QUANTITY.match(text))
        and not STEP_NUMBER.match(text)
        and len(text) <= 90
        and len(text.split()) <= 15
    )


def _listish(lines: list[Line]) -> bool:
    """A paragraph that reads as a list of ingredients: more than half its
    lines (headings aside) start with an amount. A step that wraps rarely
    starts more than one line with a number."""
    amounts = sum(_ingredientish(ln.text) for ln in lines)
    others = sum(not _ingredientish(ln.text) and not _is_heading(ln.text) for ln in lines)
    return amounts > 0 and amounts > others


def _stepish(lines: list[Line]) -> bool:
    """A paragraph that reads as a step: numbered, or a sentence or longer."""
    text = " ".join(ln.text for ln in lines)
    return (
        bool(STEP_NUMBER.match(text))
        or len(text.split()) >= 12
        or (text.endswith(".") and len(text.split()) >= 6)
    )


def recipe_from_pages(pages: list[list[Block]]) -> Draft:
    """Sort a recipe's pages, read in order, into a draft for the form."""
    draft = Draft()
    blocks = [b for page in pages for b in reading_order(page)]
    paragraphs = [p for b in blocks for p in b.paragraphs]
    if not paragraphs:
        return draft

    # The title: the biggest text in the first page's top blocks that isn't
    # an amount, a time or a heading like "Ingredients".
    first = [p for b in reading_order(pages[0])[:4] for p in b.paragraphs] if pages else []
    candidates = [
        ln
        for p in first
        for ln in p
        if not _ingredientish(ln.text)
        and not SERVES.search(ln.text)
        and not INGREDIENTS_HEAD.match(ln.text)
        and not STEPS_HEAD.match(ln.text)
        and len(ln.text.split()) <= 12
    ]
    title_line = max(candidates, key=lambda ln: ln.height, default=None)
    if title_line:
        draft.title = title_line.text.rstrip(":")

    mode = "start"  # then "ingredients", then "steps"
    for para in paragraphs:
        text = " ".join(ln.text for ln in para)
        if title_line and para[0] is title_line and len(para) == 1:
            continue
        # Servings and times can sit anywhere; take them, keep reading.
        meta = False
        if draft.servings is None and (m := SERVES.search(text)) and len(text.split()) <= 12:
            draft.servings = float(m.group(1))
            meta = True
        for kind, pattern in TIMES.items():
            if (m := pattern.search(text)) and len(text.split()) <= 16:
                setattr(draft, f"{kind}_minutes", _minutes(m))
                meta = True
        if meta:
            continue
        if INGREDIENTS_HEAD.match(text):
            mode = "ingredients"
            continue
        if STEPS_HEAD.match(text):
            mode = "steps"
            continue

        if _listish(para):
            # A list of amounts: ingredients, wherever they turn up (a second
            # column can be read after the steps). A line without an amount
            # among them ("Salt and pepper") is kept, to check.
            if mode == "start":
                mode = "ingredients"
            for ln in para:
                _add_ingredient(
                    draft,
                    ln,
                    unsure=not _ingredientish(ln.text) and not _is_heading(ln.text),
                )
            continue
        if mode == "ingredients" and not _stepish(para):
            # Short lines among the ingredients: "Salt and pepper", "Olive
            # oil", or a section ("For the dressing").
            for ln in para:
                _add_ingredient(draft, ln, unsure=not _is_heading(ln.text))
            continue
        if _stepish(para) and mode != "start":
            mode = "steps"
            step = STEP_NUMBER.sub("", text).strip()
            draft.instructions.append(step)
            if any(ln.confidence < UNSURE_BELOW for ln in para):
                draft.unsure.append(step)
            continue
        if mode == "steps" and _is_heading(text):
            continue  # "Notes", "To serve": a heading among the steps
        draft.skipped.append(text)
    return draft


def _add_ingredient(draft: Draft, line: Line, unsure: bool = False) -> None:
    """Add a line to the ingredients (a heading as a section), noting it to
    check when it was read poorly or placed by guess."""
    text = re.sub(r"^\s*[-–•*▢☐□]\s*", "", line.text).strip()
    if not text:
        return
    if _is_heading(text) and not _ingredientish(text):
        draft.ingredients.append(text if text.endswith(":") else f"{text}:")
        return
    draft.ingredients.append(text)
    if unsure or line.confidence < UNSURE_BELOW:
        draft.unsure.append(text)
