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
import math
import re
from collections.abc import Callable
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
    """One line of text on a page, as Vision read it, with its box in upright
    page coordinates (pixels)."""

    text: str
    # Average word height on the page, in pixels: bigger text is a title.
    height: float = 0.0
    # The least sure word on the line (0-1).
    confidence: float = 1.0
    left: float = 0.0
    top: float = 0.0
    right: float = 0.0
    bottom: float = 0.0


@dataclass
class Block:
    """A block of text on a page, with its box (upright pixels) and its
    paragraphs, each a list of lines, and the size of the page it's on."""

    left: float
    top: float
    right: float
    bottom: float
    paragraphs: list[list[Line]] = field(default_factory=list)
    page_width: float = 0.0
    page_height: float = 0.0


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


# ---------------------------------------------------------------------------
# Layout: Vision's words, turned upright and put back into lines and blocks.

Point = tuple[float, float]


def _points(poly: dict[str, Any]) -> list[Point]:
    """A Vision bounding polygon's corners, as given (in reading order: top
    left, top right, bottom right, bottom left of the text)."""
    return [(float(v.get("x", 0)), float(v.get("y", 0))) for v in poly.get("vertices") or []]


def _upright(page: dict[str, Any]) -> tuple[Callable[[Point], Point], float, float]:
    """How to turn a page's points upright: the way most words run is "left
    to right". Returns the transform and the upright page's width and height,
    so a photo taken sideways or upside down reads like any other."""
    votes = [0, 0, 0, 0]
    for b in page.get("blocks") or []:
        for p in b.get("paragraphs") or []:
            for w in p.get("words") or []:
                pts = _points(w.get("boundingBox") or {})
                if len(pts) == 4:
                    dx, dy = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
                    if dx or dy:
                        votes[round(math.atan2(dy, dx) / (math.pi / 2)) % 4] += 1
    cos, sin = [(1, 0), (0, 1), (-1, 0), (0, -1)][votes.index(max(votes))]

    def turn(pt: Point) -> Point:
        """Rotate so the text runs along +x and lines stack along +y."""
        return pt[0] * cos + pt[1] * sin, -pt[0] * sin + pt[1] * cos

    w, h = float(page.get("width") or 0), float(page.get("height") or 0)
    corners = [turn(c) for c in ((0, 0), (w, 0), (0, h), (w, h))]
    ox, oy = min(c[0] for c in corners), min(c[1] for c in corners)

    def upright(pt: Point) -> Point:
        """A point in upright page coordinates."""
        x, y = turn(pt)
        return x - ox, y - oy

    width = max(c[0] for c in corners) - ox
    height = max(c[1] for c in corners) - oy
    return upright, width, height


@dataclass
class _Word:
    """One Vision word in upright page coordinates, with its text, height,
    confidence and how it breaks (space or hyphen), for building lines."""

    text: str
    left: float
    top: float
    right: float
    bottom: float
    height: float
    confidence: float
    # Vision saw a space (or a line end) after it.
    spaced: bool
    # Broken across lines with a hyphen.
    hyphen: bool
    # The middle of its left and right ends, to follow a sloping line.
    start: Point = (0.0, 0.0)
    end: Point = (0.0, 0.0)


def _word(w: dict[str, Any], upright: Callable[[Point], Point]) -> _Word | None:
    """One Vision word, upright, with its true height (the box's side, which
    stays right on curved or tilted text)."""
    text, brk = "", None
    for s in w.get("symbols") or []:
        text += s.get("text", "")
        brk = ((s.get("property") or {}).get("detectedBreak") or {}).get("type")
    if not text:
        return None
    raw = _points(w.get("boundingBox") or {})
    pts = [upright(p) for p in raw] or [(0.0, 0.0)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    if len(raw) == 4:
        height = math.dist(raw[0], raw[3])
        start = ((pts[0][0] + pts[3][0]) / 2, (pts[0][1] + pts[3][1]) / 2)
        end = ((pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2)
    else:
        height = max(ys) - min(ys)
        start, end = (min(xs), (min(ys) + max(ys)) / 2), (max(xs), (min(ys) + max(ys)) / 2)
    return _Word(
        text=text,
        left=min(xs),
        top=min(ys),
        right=max(xs),
        bottom=max(ys),
        height=height,
        confidence=float(w.get("confidence", 1.0)),
        spaced=brk in ("SPACE", "SURE_SPACE", "EOL_SURE_SPACE", "LINE_BREAK"),
        hyphen=brk == "HYPHEN",
        start=start,
        end=end,
    )


def _lines(words: list[_Word]) -> list[Line]:
    """A paragraph's words put into lines by following each line along the
    page, word to word, so a sloping or curving line stays one line (Vision
    can put a line's last word on the next one), each read left to right."""
    rows: list[list[_Word]] = []
    for w in words:
        best, best_dy = None, math.inf
        for row in rows:
            last = row[-1]
            size = max(w.height, last.height, 1.0)
            gap = w.start[0] - last.end[0]
            dy = abs(w.start[1] - last.end[1])
            if -0.5 * size <= gap <= 3 * size and dy < 0.45 * size and dy < best_dy:
                best, best_dy = row, dy
        if best is None:
            rows.append([w])
        else:
            best.append(w)
    out = []
    for row in rows:
        row.sort(key=lambda w: w.left)
        text = ""
        for i, w in enumerate(row):
            text += w.text + ("-" if w.hyphen and i == len(row) - 1 else "")
            if w.spaced and i < len(row) - 1:
                text += " "
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            out.append(
                Line(
                    text=text,
                    height=sum(w.height for w in row) / len(row),
                    confidence=min(w.confidence for w in row),
                    left=min(w.left for w in row),
                    top=min(w.top for w in row),
                    right=max(w.right for w in row),
                    bottom=max(w.bottom for w in row),
                )
            )
    return sorted(out, key=lambda ln: ln.top)


def blocks_of(annotation: dict[str, Any]) -> list[Block]:
    """Vision's fullTextAnnotation for one page, as upright blocks of
    paragraphs of lines, with each line's box, height and confidence."""
    blocks = []
    for page in annotation.get("pages") or []:
        upright, width, height = _upright(page)
        for b in page.get("blocks") or []:
            if b.get("blockType", "TEXT") != "TEXT":
                continue
            pts = [upright(p) for p in _points(b.get("boundingBox") or {})] or [(0.0, 0.0)]
            block = Block(
                left=min(p[0] for p in pts),
                top=min(p[1] for p in pts),
                right=max(p[0] for p in pts),
                bottom=max(p[1] for p in pts),
                page_width=width,
                page_height=height,
            )
            for p in b.get("paragraphs") or []:
                words = [w for w in (_word(w, upright) for w in p.get("words") or []) if w]
                lines = _lines(words)
                if lines:
                    block.paragraphs.append(lines)
            if block.paragraphs:
                blocks.append(block)
    return blocks


def reading_order(blocks: list[Block]) -> list[Block]:
    """Blocks in the order a person reads them, by cutting the page at clear
    gaps: into columns where a gap runs top to bottom, otherwise into bands
    where one runs across, and the same within each part. A title across two
    columns is read first; a two-page spread is read a page at a time."""
    if len(blocks) <= 1:
        return list(blocks)
    columns = _split(blocks, across=False)
    if len(columns) > 1:
        return [b for col in columns for b in reading_order(col)]
    bands = _split(blocks, across=True)
    if len(bands) == 1:
        return sorted(blocks, key=lambda b: (b.top, b.left))
    # Bands that each have columns are one stretch of columns (a cut across
    # them would read the columns side by side, a row at a time): keep them
    # together, so each column is read through.
    regions: list[list[Block]] = []
    in_columns = False
    for band in bands:
        has_columns = len(_split(band, across=False)) > 1
        if regions and has_columns and in_columns:
            regions[-1].extend(band)
        else:
            regions.append(list(band))
        in_columns = has_columns
    if len(regions) == 1:
        regions = bands
    return [b for region in regions for b in reading_order(region)]


def _split(blocks: list[Block], across: bool) -> list[list[Block]]:
    """Blocks split at every gap no block crosses: vertical gaps (columns),
    or with `across`, horizontal ones (bands)."""

    def span(b: Block) -> tuple[float, float]:
        return (b.top, b.bottom) if across else (b.left, b.right)

    parts: list[list[Block]] = []
    reach = -math.inf
    for b in sorted(blocks, key=lambda b: span(b)[0]):
        start, end = span(b)
        if parts and start <= reach:
            parts[-1].append(b)
        else:
            parts.append([b])
        reach = max(reach, end)
    return parts


# ---------------------------------------------------------------------------
# Sorting the text into a recipe.

QUANTITY = re.compile(
    r"^\s*(?:[-–•*▢☐□]\s*)?"
    r"(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞]"
    r"|(?:a|an|one|two|three|four|five|six|eight|twelve|half|a few|several|pinch|"
    r"dash|handful|large|small|medium|juice of|zest of)\b)",
    re.I,
)
_DURATION = (
    r"\W{0,3}(?:about|approx\.?|approximately|around)?\s*"
    r"(\d+)(?:\s*(?:to|-|–)\s*(\d+))?\s*(h|hrs?|hours?|m|mins?|minutes?)\b"
    r"(?:\s*(?:and\s*)?(\d+)\s*(?:m|mins?|minutes?)\b)?"
)
TIMES = {
    "prep": re.compile(r"\bprep(?:aration)?(?: time)?" + _DURATION, re.I),
    "cook": re.compile(r"\b(?:cook(?:ing)?|bak(?:e|ing))(?: time)?" + _DURATION, re.I),
    "total": re.compile(r"\b(?:total|ready in)(?: time)?" + _DURATION, re.I),
}
SERVES = [
    re.compile(r"\bserv(?:es|ings?)\b\D{0,10}?(\d+(?:\.\d+)?)", re.I),
    re.compile(r"\b(\d+(?:\.\d+)?)\s+servings?\b", re.I),
    # "Makes 4", "Makes 6 portions"; not "Makes about 8 cups" or "one 9-inch pie".
    re.compile(r"\b(?:makes|yields?)\s+(\d+)\s*(?:servings?|portions?|people)?\s*\W*$", re.I),
]
# A line of servings and times ("Serves 6", "Prep time: about 1 hour").
META = re.compile(
    r"^\W*(?:serves|servings|makes|yields?|prep|preparation|cook|cooking|bake|baking|"
    r"total|ready in|active)\b",
    re.I,
)
YIELD = re.compile(r"^\W*(?:serves|servings|makes|yields?)\b", re.I)
INGREDIENTS_HEAD = re.compile(r"^(?:ingredients?|you(?:'|’)ll need|you will need)\s*:?$", re.I)
STEPS_HEAD = re.compile(
    r"^(?:method|directions?|instructions?|preparation|to make|steps?)\s*:?$", re.I
)
STEP_NUMBER = re.compile(r"^\s*(?:step\s*)?\d+[.)]\s+", re.I)
SECTION = re.compile(r"^(?:for the|for)\b.{1,40}$", re.I)
# A heading among the steps that's part of them ("For the sauce", "To finish").
SUBSTEP = re.compile(r"^(?:for|to)\b", re.I)
# How steps start ("Stir until smooth"); a line in an ingredient list without
# an amount names a food instead ("Salt and pepper").
STEP_VERB = re.compile(
    r"^(?:add|bake|beat|blend|boil|bring|chop|combine|cook|cover|cut|drain|fold|fry|"
    r"heat|let|mix|place|pour|preheat|put|reduce|remove|roast|saut[eé]|season|serve|"
    r"set|simmer|sprinkle|spread|stir|toss|transfer|turn|whisk)\b",
    re.I,
)
# A line ending mid-phrase: the next line carries on.
OPEN_END = re.compile(r"(?:[,(/\-–—]|\b(?:or|and|of|with|to|for|in|plus|a|the))$", re.I)


def _minutes(m: re.Match[str]) -> int:
    """Minutes from a duration match: "1 hour 15 min" is 75, and "30 to 40
    minutes" is 40 (planning for the longer)."""
    n = int(m.group(2) or m.group(1))
    total = n * 60 if m.group(3).lower().startswith("h") else n
    return total + (int(m.group(4)) if m.group(4) else 0)


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


def _clean(blocks: list[Block]) -> list[Block]:
    """A page's blocks without what isn't the page itself, and with stray
    words put back: a word or two Vision set apart that ends a line in
    another block ("… ground black" | "pepper") rejoins it; a strip of word
    fragments beside the text (the facing page, cut off by the frame) goes."""
    lines = [ln for b in blocks for p in b.paragraphs for ln in p]
    full = [ln for ln in lines if len(ln.text.split()) >= 4]
    text_left = min((ln.left for ln in full), default=-math.inf)
    text_right = max((ln.right for ln in full), default=math.inf)
    kept = []
    for b in blocks:
        own = [ln for p in b.paragraphs for ln in p]
        words = sum(len(ln.text.split()) for ln in own) / max(len(own), 1)
        outside = b.left >= text_right - 5 or b.right <= text_left + 5
        if outside and words <= 2.5:
            continue
        if len(own) == 1 and len(own[0].text.split()) <= 2:
            stray = own[0]
            size = max(stray.height, 1.0)
            for ln in lines:
                if (
                    ln is not stray
                    and not _is_heading(stray.text)
                    and not INGREDIENTS_HEAD.match(stray.text)
                    and not STEPS_HEAD.match(stray.text)
                    # Word spacing, well under a column gutter.
                    and 0 <= stray.left - ln.right < size
                    and abs((ln.top + ln.bottom) / 2 - (stray.top + stray.bottom) / 2) < 0.6 * size
                ):
                    ln.text = f"{ln.text} {stray.text}"
                    ln.right = stray.right
                    break
            else:
                kept.append(b)
            continue
        kept.append(b)
    return kept


def _furniture_line(ln: Line, b: Block, page: list[Line]) -> bool:
    """A page number, a running head or footer ("155 Frittatas", "Pâte à
    Choux | 47"), or a rule of dots: not part of the recipe. A short line with
    a number counts only at the very top or bottom of the page, with no other
    text between it and the edge, set apart from the text by a gap (a tightly
    framed photo's last ingredient isn't a footer)."""
    text = ln.text
    if not re.search(r"[A-Za-z0-9]", text) or re.fullmatch(r"\W*\d{1,4}\W*", text):
        return True
    if not b.page_height or len(text.split()) > 6 or not re.search(r"\d", text):
        return False
    margin, gap = 0.07 * b.page_height, 1.5 * max(ln.height, 1.0)
    others = [o for o in page if o is not ln]
    if ln.bottom < margin:
        # Nothing above it, and set apart from the text below.
        return not any(o.bottom < ln.top for o in others) and not any(
            ln.bottom <= o.top < ln.bottom + gap for o in others
        )
    if ln.top > b.page_height - margin:
        return not any(o.top > ln.bottom for o in others) and not any(
            ln.top - gap < o.bottom <= ln.top for o in others
        )
    return False


def _continues(prev: Line, ln: Line, margin: float) -> bool:
    """Whether a line carries on the one before rather than starting a new
    item: indented (a hanging indent), starting in lower case or with a
    bracket, or after a line that ends mid-phrase or with a bracket open."""
    text = ln.text
    if ln.left - margin > 0.8 * max(ln.height, 1.0):
        return True
    if text[:1].islower() or text[:1] in "([":
        return True
    return bool(OPEN_END.search(prev.text)) or prev.text.count("(") > prev.text.count(")")


def _join(lines: list[Line]) -> str:
    """Lines as one text, mending words broken with a hyphen."""
    text = ""
    for ln in lines:
        if text.endswith("-") and ln.text[:1].islower():
            text = text[:-1] + ln.text
        else:
            text = f"{text} {ln.text}".strip()
    return text


def _items(lines: list[Line]) -> list[tuple[str, list[Line]]]:
    """A paragraph split into items: a new one starts at each line that
    doesn't carry on the one before."""
    margin = min(ln.left for ln in lines)
    groups: list[list[Line]] = []
    for ln in lines:
        if groups and _continues(groups[-1][-1], ln, margin):
            groups[-1].append(ln)
        else:
            groups.append([ln])
    return [(_join(g), g) for g in groups]


def _ingredient_like(text: str) -> bool:
    """An item that reads as an ingredient: short, not a sentence, and
    either starting with an amount or naming a food ("Salt", "Extra-virgin
    olive oil") rather than an action."""
    words = text.split()
    if STEP_NUMBER.match(text) or text.endswith(".") or re.search(r"[.!?] [A-Z]", text):
        return False
    if _ingredientish(text.split(",")[0]) or QUANTITY.match(text):
        return len(words) <= 40
    return len(words) <= 12 and not STEP_VERB.match(text)


def _meta(text: str, draft: Draft) -> bool:
    """Take servings and times from a line like "Serves 6" or "Prep time:
    about 1 hour"; True when the line is only that. A step can start with a
    time ("Bake 25 to 30 minutes, until set."): "Cook" and "Bake" count only
    as "Cook time" or "Bake:", and a line in lower case is part of a step."""
    if text[:1].islower() or (
        re.match(r"^\W*(?:cook|cooking|bake|baking)\b", text, re.I)
        and not re.match(r"^\W*(?:cook|cooking|bake|baking)\b\s*(?:time\b|:)", text, re.I)
    ):
        return False
    found = False
    for pattern in SERVES:
        if m := pattern.search(text):
            if draft.servings is None:
                draft.servings = float(m.group(1))
            found = True
            break
    for kind, pattern in TIMES.items():
        if m := pattern.search(text):
            if getattr(draft, f"{kind}_minutes") is None:
                setattr(draft, f"{kind}_minutes", _minutes(m))
            found = True
    if not META.match(text) or len(text.split()) > 14:
        return False
    # "Makes about 8 cups" is a yield line even without servings in it; a
    # line starting "Cook…" is only a time when it gives one.
    return found or bool(YIELD.match(text))


def _title(blocks: list[Block]) -> tuple[str, Line | None, list[Line]]:
    """The recipe's name: the line on the first page that stands out most in
    size from the text around it (a photo taken at an angle makes the near
    edge bigger, so size alone misleads), in a short paragraph, and not an
    amount, a time or a heading like "Ingredients". The lines it wraps onto
    come with it ("Caramelized / Onion Pie"); a label before a colon
    ("Chunky: Tuscan Bean Soup") is left off."""
    every = [ln for b in blocks for p in b.paragraphs for ln in p]
    page_height = max((b.page_height for b in blocks), default=0.0) or max(
        (ln.bottom for ln in every), default=1.0
    )
    best: tuple[float, Line, list[Line]] | None = None
    for b in blocks:
        for para in b.paragraphs:
            if len(para) > 3 or sum(len(ln.text.split()) for ln in para) > 16:
                continue
            for ln in para:
                text = ln.text
                if (
                    _ingredientish(text)
                    or text[:1].islower()
                    or META.match(text)
                    or INGREDIENTS_HEAD.match(text)
                    or STEPS_HEAD.match(text)
                    or not re.search(r"[A-Za-z]{2}", text)
                ):
                    continue
                near = sorted(
                    o.height
                    for o in every
                    if o is not ln and abs(o.top - ln.top) < 0.15 * page_height
                )
                around = near[len(near) // 2] if near else ln.height
                score = ln.height / max(around, 1.0)
                if best is None or score > best[0]:
                    best = (score, ln, para)
    if best is None:
        return "", None, []
    _, line, para = best
    # The neighbouring lines of the same size are the rest of it.
    i = para.index(line)
    lo = i
    while lo > 0 and para[lo - 1].height >= 0.85 * line.height:
        lo -= 1
    hi = i
    while hi + 1 < len(para) and para[hi + 1].height >= 0.85 * line.height:
        hi += 1
    lines = para[lo : hi + 1]
    text = _join(lines).rstrip(":")
    if (m := re.match(r"^[\w'’-]+(?: [\w'’-]+)?: (.+)$", text)) and len(m.group(1).split()) >= 2:
        text = m.group(1)
    return text, line, lines


def recipe_from_pages(pages: list[list[Block]]) -> Draft:
    """Sort a recipe's pages into a draft for the form. On the first page the
    recipe starts at its title (text above it is the recipe before). Prose
    before the ingredients is the introduction; prose after them is the
    steps, until a heading such as "Serving ideas" starts the notes."""
    draft = Draft()
    ordered: list[list[Block]] = []
    for page in pages:
        ordered.append(reading_order(_clean(page)))
    if not any(ordered):
        return draft
    draft.title, title_line, title_lines = _title(ordered[0])
    if title_line:
        ordered[0] = [b for b in ordered[0] if b.bottom >= title_line.top]

    mode = "start"  # then "ingredients", "steps", and "notes"
    section: str | None = None  # a heading waiting for its list
    for blocks in ordered:
        page_lines = [ln for b in blocks for p in b.paragraphs for ln in p]
        for b in blocks:
            for para in b.paragraphs:
                lines = []
                for ln in para:
                    if ln in title_lines:
                        continue
                    # Furniture first: a footer's numbers aren't the recipe's.
                    if _furniture_line(ln, b, page_lines):
                        if re.search(r"[A-Za-z]{2}", ln.text):
                            draft.skipped.append(ln.text)  # to see, in "Left out"
                        continue
                    if not _meta(ln.text, draft):
                        lines.append(ln)
                if not lines:
                    continue
                text = _join(lines)
                if INGREDIENTS_HEAD.match(text):
                    mode = "ingredients"
                    continue
                if STEPS_HEAD.match(text):
                    mode = "steps"
                    continue
                if len(lines) == 1 and _is_heading(text) and not _ingredientish(text):
                    if mode == "steps" and not SUBSTEP.match(text):
                        mode = "notes"  # "Serving ideas", "More ways"
                    if mode == "notes":
                        draft.skipped.append(text)
                    else:
                        # "FILLING", "For the topping:": a section, if a list
                        # follows (among the steps, it may head steps instead).
                        section = text
                    continue

                if (
                    mode == "steps"
                    and draft.instructions
                    and text[:1].islower()
                    and not draft.instructions[-1].endswith((".", "!"))
                ):
                    # A step Vision split in two: it carries on mid-sentence.
                    draft.instructions[-1] = _join([Line(draft.instructions[-1]), Line(text)])
                    continue
                items = _items(lines)
                if mode != "notes" and _is_list(items):
                    if mode == "start":
                        mode = "ingredients"
                    if section:
                        _add_ingredient(draft, section, 1.0)
                        section = None
                    for item, item_lines in items:
                        _add_ingredient(
                            draft,
                            item,
                            min(ln.confidence for ln in item_lines),
                            unsure=not QUANTITY.match(item) and not _is_heading(item),
                        )
                    continue
                if mode == "notes" or (mode == "start" and not STEP_NUMBER.match(text)):
                    draft.skipped.append(text)  # the introduction, or notes
                    continue
                mode = "steps"
                section = None
                step = STEP_NUMBER.sub("", text).strip()
                draft.instructions.append(step)
                if any(ln.confidence < UNSURE_BELOW for ln in lines):
                    draft.unsure.append(step)
    return draft


def _is_list(items: list[tuple[str, list[Line]]]) -> bool:
    """A paragraph whose items read as ingredients: most of them do, and
    none without an amount reads as an action ("Stir until smooth")."""
    texts = [t for t, _ in items if not _is_heading(t)]
    if not texts:
        return False
    like = sum(_ingredient_like(t) for t in texts)
    if any(STEP_VERB.match(t) and not QUANTITY.match(t) for t in texts):
        return False
    return like * 2 > len(texts)


def _add_ingredient(draft: Draft, text: str, confidence: float, unsure: bool = False) -> None:
    """Add an ingredient (a heading as a section, "FILLING" as "Filling:"),
    noting it to check when it was read poorly or placed by guess."""
    text = re.sub(r"^\s*[-–•*▢☐□»]\s*", "", text).strip()
    if not text:
        return
    if _is_heading(text) and not _ingredientish(text):
        name = text.rstrip(":").strip()
        draft.ingredients.append(f"{name.capitalize() if name.isupper() else name}:")
        return
    draft.ingredients.append(text)
    if unsure or confidence < UNSURE_BELOW:
        draft.unsure.append(text)
