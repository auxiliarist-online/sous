"""Postgres fixtures for integration tests.

SOUS_TEST_DATABASE_URL points at the database. With SOUS_TEST_DB_FRESH=1 (CI's
throwaway container) the Supabase stub and every migration are applied first;
otherwise the database must already be migrated (e.g. the Supabase project).

Every test runs inside a transaction that is rolled back, so nothing is kept.
"""

import os
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path

import psycopg
import pytest

REPO = Path(__file__).resolve().parents[4]
SUPABASE = REPO / "supabase"


def _apply(conn: psycopg.Connection, sql_file: Path) -> None:
    # A whole file in one call; allowed because it has no parameters.
    conn.execute(sql_file.read_text().encode())


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    url = os.environ["SOUS_TEST_DATABASE_URL"]
    if os.environ.get("SOUS_TEST_DB_FRESH") == "1":
        with psycopg.connect(url, autocommit=True) as conn:
            _apply(conn, SUPABASE / "tests" / "supabase_stub.sql")
            for migration in sorted((SUPABASE / "migrations").glob("*.sql")):
                _apply(conn, migration)
            _apply(conn, SUPABASE / "tests" / "grants.sql")
    yield url


@pytest.fixture
def db(database_url: str) -> Iterator[psycopg.Connection]:
    """A connection inside a transaction that is always rolled back."""
    with psycopg.connect(database_url) as conn:
        try:
            yield conn
        finally:
            conn.rollback()


@pytest.fixture
def make_user(db: psycopg.Connection) -> Callable[[], str]:
    """Create a throwaway auth user (rolled back with the test)."""

    def make() -> str:
        user_id = str(uuid.uuid4())
        db.execute("insert into auth.users (id) values (%s)", [user_id])
        return user_id

    return make


@pytest.fixture
def as_user(db: psycopg.Connection) -> Callable[[str | None], AbstractContextManager[None]]:
    """Run queries as Supabase would for a signed-in user (or anon with None)."""

    @contextmanager
    def switch(user_id: str | None) -> Iterator[None]:
        db.execute("savepoint as_user")
        db.execute("set local role " + ("authenticated" if user_id else "anon"))
        db.execute("select set_config('request.jwt.claim.sub', %s, true)", [user_id or ""])
        try:
            yield
        finally:
            db.execute("rollback to savepoint as_user")

    return switch
