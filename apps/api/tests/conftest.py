"""Test layers (see tests/README.md):

- tests/unit         fast, no network or database; always run
- tests/integration  need Postgres at SOUS_TEST_DATABASE_URL; skipped without it
- tests/live         hit real websites; only with --live
"""

import os

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--live", action="store_true", help="also run tests that fetch real websites")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    has_db = bool(os.environ.get("SOUS_TEST_DATABASE_URL"))
    require_db = os.environ.get("SOUS_TEST_REQUIRE_DB") == "1"
    for item in items:
        path = item.path.as_posix()
        if "/tests/integration/" in path:
            item.add_marker(pytest.mark.integration)
            if not has_db:
                if require_db:
                    raise pytest.UsageError(
                        "SOUS_TEST_DATABASE_URL is required (SOUS_TEST_REQUIRE_DB=1)"
                    )
                item.add_marker(pytest.mark.skip(reason="set SOUS_TEST_DATABASE_URL to run"))
        elif "/tests/live/" in path:
            item.add_marker(pytest.mark.live)
            if not config.getoption("--live"):
                item.add_marker(pytest.mark.skip(reason="needs --live"))
        else:
            item.add_marker(pytest.mark.unit)
