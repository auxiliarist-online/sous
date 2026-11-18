"""The substitutions file is checked before it becomes a migration (TYL-77)."""

from pathlib import Path

import pytest

from scripts.build_substitutions import key, migration, rows

HEADER = "from,to,factor,to_unit,per,extras,uses,quality,note\n"
GOOD = "Buttermilk,whole milk,1,,,lemon juice,any,good,Stir in lemon juice; let it sit.\n"


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "substitutions.csv"
    path.write_text(HEADER + body)
    return path


def test_the_real_file_is_valid() -> None:
    data = rows()
    assert len(data) >= 100
    assert all(r["note"] for r in data)


def test_keys_name_the_swap() -> None:
    assert key({"from": "eggs", "to": "flaxseed", "extras": "water"}) == "eggs > flaxseed + water"
    assert key({"from": "butter", "to": "ghee", "extras": ""}) == "butter > ghee"


def test_a_swap_becomes_an_upsert(tmp_path: Path) -> None:
    data = rows(
        write(tmp_path, GOOD + 'eggs,flaxseed,1,tbsp,each,water,baking,good,"Per egg, 1 tbsp."\n')
    )
    assert data[0]["from"] == "buttermilk"
    sql = migration(data)
    assert (
        "('buttermilk > whole milk + lemon juice', 'buttermilk', 'whole milk', 1, null, null, "
        "'{\"lemon juice\"}'::text[]" in sql
    )
    assert "'tbsp', 'each', '{\"water\"}'::text[], 'baking', 'good', 'Per egg, 1 tbsp.'" in sql
    assert "on conflict (key) do update" in sql
    assert "raise exception 'substitutions name unknown ingredients" in sql


@pytest.mark.parametrize(
    ("old", "new"),
    [
        (",1,,,", ",0,,,"),  # factor
        (",1,,,", ",1,tbsp,,"),  # a unit without per
        (",1,,,", ",1,pinch,each,"),  # not a unit
        ("any,", "raw,"),  # uses
        ("good,", "great,"),  # quality
        ("Stir in lemon juice; let it sit.", ""),  # no note
        ("whole milk", "buttermilk"),  # a swap for itself
        ("Stir in lemon juice; let it sit.", "Stir, then sit."),  # unquoted comma
    ],
)
def test_bad_rows_stop_the_build(tmp_path: Path, old: str, new: str) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, GOOD.replace(old, new, 1)))


def test_a_swap_twice_stops_the_build(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        rows(write(tmp_path, GOOD + GOOD))
