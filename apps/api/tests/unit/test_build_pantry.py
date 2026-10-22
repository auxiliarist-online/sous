"""The pantry data file is checked before it becomes a migration (TYL-134, TYL-135)."""

from pathlib import Path

import pytest

from scripts.build_pantry import migration, rows


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "pantry.csv"
    path.write_text("ingredient,group,kits\n" + body)
    return path


def test_the_real_file_is_valid() -> None:
    data = rows()
    assert len(data) > 200
    kits = {k for r in data for k in r["kits"].split()}
    assert {"basics", "indian", "thai", "vegan", "gluten_free"} <= kits


def test_names_are_lower_cased_and_kits_listed(tmp_path: Path) -> None:
    (row,) = rows(write(tmp_path, "Garam Masala,spices,basics indian\n"))
    assert row["ingredient"] == "garam masala"
    sql = migration([row])
    assert "('garam masala', 'spices')" in sql
    assert "('garam masala', 'basics')" in sql
    assert "('garam masala', 'indian')" in sql


def test_an_ingredient_in_no_kit_is_still_grouped(tmp_path: Path) -> None:
    (row,) = rows(write(tmp_path, "capers,cans,\n"))
    sql = migration([row])
    assert "('capers', 'cans')" in sql
    assert "insert into pantry_kit_rows" not in sql


@pytest.mark.parametrize(
    "line",
    [
        "capers,jars,\n",  # not a group
        "capers,cans,Italian\n",  # kit not lower case
        "capers,cans,italian italian\n",  # a kit twice
        "   ,cans,\n",  # no ingredient name
    ],
)
def test_bad_rows_stop_the_build(tmp_path: Path, line: str) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, line))


def test_an_ingredient_twice_stops_the_build(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, "capers,cans,\nCapers,sauces,\n"))
