"""The seasonality data file is checked before it becomes a migration (TYL-70)."""

from pathlib import Path

import pytest

from scripts.build_seasonality import migration, rows


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "seasonality.csv"
    path.write_text("ingredient,region,months,chart_crop\n" + body)
    return path


def test_the_real_file_is_valid() -> None:
    data = rows()
    assert {r["region"] for r in data} == {"US", "NC"}
    assert all(r["ingredient"] == r["ingredient"].lower() for r in data)


def test_names_are_lower_cased_to_match(tmp_path: Path) -> None:
    (row,) = rows(write(tmp_path, "Butternut Squash,US,9 10,Winter Squash\n"))
    assert row["ingredient"] == "butternut squash"
    assert "('butternut squash', 'US', '{9,10}'::smallint[])" in migration([row])


@pytest.mark.parametrize(
    "line",
    [
        "kale,us,1 2,Kale\n",  # region in lower case
        "kale,USA,1 2,Kale\n",  # not a region the table takes
        "kale,US,1 x,Kale\n",  # not a month
        "kale,US,0 13,Kale\n",  # out of range
        "kale,US,,Kale\n",  # none
    ],
)
def test_bad_rows_stop_the_build(tmp_path: Path, line: str) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, line))


def test_an_ingredient_twice_in_a_region_stops_the_build(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, "kale,US,1,Kale\nKale,US,2,Kale\n"))
