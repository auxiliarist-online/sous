"""Turn data/local_places.csv into a migration (TYL-69).

    .venv/bin/python scripts/build_local_places.py 20261111010000_local_places_data

data/local_places.csv is the local food directory, entered by hand from
public listings: ASAP's Local Food Guide (https://appalachiangrown.org), the
markets' and shops' own websites, and the NC Department of Agriculture. Only
facts are kept (address, hours, what's sold), never copied descriptions; each
row records its source and the day it was checked. Coordinates come from the
US Census geocoder (https://geocoding.geo.census.gov), or OpenStreetMap where
the Census has no match.

Columns:

* slug: the row's stable key (lower case, digits, hyphens); re-running the
  build updates the place with that slug.
* kind: farmers_market, co_op, grocer, bakery, butcher, fish_market or
  farm_store.
* sells: space-separated, from SELLS.
* hours: "; "-separated entries of days, times and an optional season:
  "Sat 09:00-12:00 04-04..11-28", "Mon-Sun 08:00-17:00", "Tue,Thu 15:00-18:00".
  Days are three-letter names, a range or a comma list; times are 24-hour;
  the season is month-day to month-day and may wrap the new year
  ("12-05..03-27").

Updating a place: edit its row, set checked_on, and write a new migration.
"""

import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

API = Path(__file__).resolve().parents[1]
DATA = API / "data" / "local_places.csv"
MIGRATIONS = API.parent.parent / "supabase" / "migrations"

KINDS = {"farmers_market", "co_op", "grocer", "bakery", "butcher", "fish_market", "farm_store"}
SELLS = {"produce", "eggs", "dairy", "meat", "seafood", "bread", "honey", "grains", "groceries"}
DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

TIME = r"([01]\d|2[0-3]):[0-5]\d"
MONTH_DAY = r"(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])"
HOURS = re.compile(
    rf"(?P<days>[A-Za-z,-]+) (?P<opens>{TIME})-(?P<closes>{TIME})"
    rf"(?: (?P<from>{MONTH_DAY})\.\.(?P<to>{MONTH_DAY}))?"
)


def sql_text(s: str) -> str:
    """A SQL string literal."""
    return "'" + s.replace("'", "''") + "'"


def parse_days(text: str) -> list[int]:
    """ "Mon-Fri" or "Tue,Thu" or "Sat" as day numbers, 0 being Sunday. A range
    may wrap the week ("Fri-Mon")."""
    out: list[int] = []
    for part in text.split(","):
        ends = part.split("-")
        if len(ends) > 2 or any(e not in DAYS for e in ends):
            raise ValueError(f"bad days {text!r}")
        first, last = DAYS.index(ends[0]), DAYS.index(ends[-1])
        n = (last - first) % 7 + 1
        out += [(first + i) % 7 for i in range(n)]
    if len(set(out)) != len(out):
        raise ValueError(f"a day twice in {text!r}")
    return sorted(out)


def real_day(month_day: str) -> bool:
    """Whether "MM-DD" is a day some year has (02-29 is, 04-31 isn't)."""
    month, day = (int(x) for x in month_day.split("-"))
    try:
        date(2024, month, day)  # a leap year
    except ValueError:
        return False
    return True


def parse_hours(text: str) -> list[dict[str, object]]:
    """The hours column as the table's JSON: one entry per "; "-separated
    part, each with its days, opening and closing times, and season."""
    out: list[dict[str, object]] = []
    for part in text.split(";"):
        m = HOURS.fullmatch(part.strip())
        if not m:
            raise ValueError(f"bad hours {part.strip()!r}")
        if m["closes"] <= m["opens"]:
            raise ValueError(f"closes before it opens: {part.strip()!r}")
        entry: dict[str, object] = {
            "days": parse_days(m["days"]),
            "opens": m["opens"],
            "closes": m["closes"],
        }
        if m["from"]:
            if not (real_day(m["from"]) and real_day(m["to"])):
                raise ValueError(f"no such day in {part.strip()!r}")
            entry["from"], entry["to"] = m["from"], m["to"]
        out.append(entry)
    return out


def rows(path: Path = DATA) -> list[dict[str, object]]:
    """The checked rows of the data file, with hours parsed; stops the build
    with every problem found."""
    out: list[dict[str, object]] = []
    seen: set[str] = set()
    errors: list[str] = []
    for n, r in enumerate(csv.DictReader(path.open(encoding="utf-8")), 2):
        r = {k: (v or "").strip() for k, v in r.items()}
        problems = []
        if not re.fullmatch(r"[a-z0-9-]+", r["slug"]):
            problems.append(f"bad slug {r['slug']!r}")
        if r["slug"] in seen:
            problems.append(f"{r['slug']} twice")
        seen.add(r["slug"])
        for field in ("name", "address", "town", "source_url"):
            if not r[field]:
                problems.append(f"no {field}")
        if r["kind"] not in KINDS:
            problems.append(f"bad kind {r['kind']!r}")
        if not re.fullmatch(r"\d{5}", r["zip"]):
            problems.append(f"bad zip {r['zip']!r}")
        try:
            lat, lng = float(r["latitude"]), float(r["longitude"])
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                raise ValueError
        except ValueError:
            problems.append("bad coordinates")
        sells = r["sells"].split()
        if not sells or not set(sells) <= SELLS:
            problems.append(f"bad sells {r['sells']!r}")
        for url in (r["website"], r["source_url"]):
            if url and not url.startswith("https://"):
                problems.append(f"not an https link: {url!r}")
        try:
            date.fromisoformat(r["checked_on"])
        except ValueError:
            problems.append(f"bad checked_on {r['checked_on']!r}")
        try:
            hours = parse_hours(r["hours"])
        except ValueError as e:
            problems.append(str(e))
            hours = []
        errors += [f"line {n}: {p}" for p in problems]
        out.append({**r, "sells": sells, "hours": hours})
    if errors:
        sys.exit("\n".join(errors))
    return out


def migration(data: list[dict[str, object]]) -> str:
    """The rows as an upsert into local_places, by slug."""

    def value(r: dict[str, object]) -> str:
        """One row of the values list."""
        sells = "{" + ",".join(r["sells"]) + "}"  # type: ignore[arg-type]
        website = sql_text(str(r["website"])) if r["website"] else "null"
        return (
            f"  ({sql_text(str(r['slug']))}, {sql_text(str(r['name']))}, "
            f"{sql_text(str(r['kind']))}, {sql_text(str(r['address']))}, "
            f"{sql_text(str(r['town']))}, {sql_text(str(r['zip']))}, "
            f"{r['latitude']}, {r['longitude']}, '{sells}'::text[], "
            f"{sql_text(json.dumps(r['hours'], separators=(',', ':')))}::jsonb, "
            f"{website}, {sql_text(str(r['source_url']))}, '{r['checked_on']}'::date)"
        )

    values = ",\n".join(value(r) for r in data)
    return f"""-- Local food directory, from apps/api/data/local_places.csv; generated by
-- apps/api/scripts/build_local_places.py (sources cited there). Don't edit
-- this file once applied.

insert into public.local_places (slug, name, kind, address, town, zip, latitude,
  longitude, sells, hours, website, source_url, checked_on)
values
{values}
on conflict (slug) do update set
  name = excluded.name, kind = excluded.kind, address = excluded.address,
  town = excluded.town, zip = excluded.zip, latitude = excluded.latitude,
  longitude = excluded.longitude, sells = excluded.sells, hours = excluded.hours,
  website = excluded.website, source_url = excluded.source_url,
  checked_on = excluded.checked_on;
"""


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = MIGRATIONS / f"{sys.argv[1]}.sql"
    if out.exists():
        sys.exit(f"{out.name} exists; migrations are append-only, pick a new name")
    data = rows()
    out.write_text(migration(data))
    print(f"wrote {out.name}: {len(data)} places")
