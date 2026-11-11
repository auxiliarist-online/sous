"""The local food directory is checked before it becomes a migration (TYL-69)."""

from pathlib import Path

import pytest

from scripts.build_local_places import migration, parse_days, parse_hours, rows

HEADER = (
    "slug,name,kind,address,town,zip,latitude,longitude,sells,hours,website,source_url,checked_on\n"
)
GOOD = (
    "city-market,City Market,farmers_market,52 N Market St,Asheville,28801,35.6,-82.55,"
    "produce eggs,Sat 09:00-12:00 04-04..11-28,,https://example.org/market,2026-11-11\n"
)


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "local_places.csv"
    path.write_text(HEADER + body)
    return path


def test_the_real_file_is_valid() -> None:
    data = rows()
    assert len(data) >= 15
    assert {r["kind"] for r in data} >= {"farmers_market", "bakery", "butcher", "co_op"}


def test_days_take_names_ranges_and_lists() -> None:
    assert parse_days("Sat") == [6]
    assert parse_days("Mon-Sun") == [0, 1, 2, 3, 4, 5, 6]
    assert parse_days("Tue,Thu") == [2, 4]
    assert parse_days("Fri-Mon") == [0, 1, 5, 6]


def test_hours_keep_their_season() -> None:
    assert parse_hours("Sat 09:00-12:00 04-04..11-28; Sat 10:00-13:00 12-05..03-27") == [
        {"days": [6], "opens": "09:00", "closes": "12:00", "from": "04-04", "to": "11-28"},
        {"days": [6], "opens": "10:00", "closes": "13:00", "from": "12-05", "to": "03-27"},
    ]
    assert parse_hours("Mon-Sat 07:30-14:30") == [
        {"days": [1, 2, 3, 4, 5, 6], "opens": "07:30", "closes": "14:30"}
    ]


def test_a_place_becomes_an_upsert(tmp_path: Path) -> None:
    sql = migration(rows(write(tmp_path, GOOD.replace("City Market", "Ann's Market"))))
    assert "'Ann''s Market'" in sql
    assert "'{produce,eggs}'::text[]" in sql
    assert (
        '\'[{"days":[6],"opens":"09:00","closes":"12:00","from":"04-04","to":"11-28"}]\'::jsonb'
        in sql
    )
    assert "on conflict (slug) do update" in sql


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("farmers_market", "flea_market"),  # not a kind the table takes
        ("produce eggs", "produce candles"),  # not something the list can match
        ("Sat 09:00", "Saturday 09:00"),  # day name
        ("09:00-12:00", "12:00-09:00"),  # closes before it opens
        ("04-04..11-28", "04-31..13-01"),  # not a month-day
        ("28801", "2880"),  # zip
        ("35.6", "135.6"),  # latitude
        ("https://example.org", "http://example.org"),  # source not https
        ("2026-11-11", "Nov 11"),  # checked_on
        ("city-market", "City Market"),  # slug
    ],
)
def test_bad_rows_stop_the_build(tmp_path: Path, old: str, new: str) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, GOOD.replace(old, new, 1)))


def test_a_slug_twice_stops_the_build(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, GOOD + GOOD))
