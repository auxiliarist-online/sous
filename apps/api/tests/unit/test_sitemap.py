import asyncio
import gzip

import httpx2 as httpx
import pytest

from app.crawl.sitemap import Entry, find_recipe_urls, parse_sitemap
from app.recipes.fetch import FetchError
from tests.helpers import sitemap_index, urlset


def xml_response(body: str | bytes, ctype: str = "application/xml") -> httpx.Response:
    return httpx.Response(200, content=body, headers={"content-type": ctype})


def find(
    files: dict[str, httpx.Response], robots: str = "", sitemap_url: str | None = None
) -> list[Entry]:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=robots)
        return files.get(request.url.path, httpx.Response(404))

    async def go() -> list[Entry]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await find_recipe_urls(client, "example-blog.com", sitemap_url)

    return asyncio.run(go())


class TestParse:
    def test_reads_a_urlset(self) -> None:
        entries, children = parse_sitemap(
            urlset([("https://example-blog.com/tacos/", "2026-09-01T10:00:00+00:00")])
        )
        assert entries == [Entry("https://example-blog.com/tacos/", "2026-09-01T10:00:00+00:00")]
        assert children == []

    def test_reads_a_sitemap_index(self) -> None:
        entries, children = parse_sitemap(sitemap_index(["https://example-blog.com/post.xml"]))
        assert (entries, children) == ([], ["https://example-blog.com/post.xml"])

    def test_tolerates_missing_namespace_dates_and_bad_dates(self) -> None:
        xml = (
            "<urlset><url><loc> https://example-blog.com/a/ </loc><lastmod>2026-09-01</lastmod>"
            "</url><url><loc>https://example-blog.com/b/</loc><lastmod>last week</lastmod></url>"
            "<url><lastmod>2026-09-01</lastmod></url></urlset>"
        )
        entries, _ = parse_sitemap(xml)
        assert entries == [
            Entry("https://example-blog.com/a/", "2026-09-01T00:00:00"),
            Entry("https://example-blog.com/b/", None),
        ]

    @pytest.mark.parametrize(
        "xml",
        [
            "<html>not a sitemap",
            # An entity bomb: defusedxml refuses entity declarations outright.
            '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><urlset>&a;</urlset>',
        ],
    )
    def test_refuses_bad_or_dangerous_xml(self, xml: str) -> None:
        with pytest.raises(FetchError) as err:
            parse_sitemap(xml)
        assert err.value.code == "not_a_sitemap"


@pytest.mark.usefixtures("no_dns")
class TestFindRecipeUrls:
    def test_follows_robots_sitemaps_and_skips_non_recipe_ones(self) -> None:
        index = sitemap_index(
            [
                "https://example-blog.com/post-sitemap.xml",
                "https://example-blog.com/category-sitemap.xml",
                "https://elsewhere.example/post-sitemap.xml",
            ]
        )
        posts = urlset(
            [
                ("https://www.example-blog.com/tacos/?utm_source=x", "2026-09-01T00:00:00+00:00"),
                ("https://example-blog.com/about/", None),
                ("https://other.example/stolen/", None),
            ]
        )
        found = find(
            {"/sitemap_index.xml": xml_response(index), "/post-sitemap.xml": xml_response(posts)},
            robots="Sitemap: https://example-blog.com/sitemap_index.xml\n",
        )
        assert found == [Entry("https://www.example-blog.com/tacos/", "2026-09-01T00:00:00+00:00")]

    def test_falls_back_to_sitemap_xml_and_reads_gzip(self) -> None:
        body = gzip.compress(urlset([("https://example-blog.com/soup/", None)]).encode())
        found = find({"/sitemap.xml": xml_response(body, "application/x-gzip")})
        assert found == [Entry("https://example-blog.com/soup/", None)]

    def test_uses_the_sources_own_sitemap_url(self) -> None:
        files = {"/recipes.xml": xml_response(urlset([("https://example-blog.com/stew/", None)]))}
        found = find(files, sitemap_url="https://example-blog.com/recipes.xml")
        assert [e.url for e in found] == ["https://example-blog.com/stew/"]

    def test_a_blocked_sitemap_is_reported(self) -> None:
        with pytest.raises(FetchError) as err:
            find({"/sitemap.xml": httpx.Response(403, headers={"cf-mitigated": "challenge"})})
        assert err.value.code == "blocked"

    def test_one_broken_child_sitemap_doesnt_lose_the_rest(self) -> None:
        index = sitemap_index(
            ["https://example-blog.com/post-sitemap.xml", "https://example-blog.com/post2.xml"]
        )
        files = {
            "/sitemap.xml": xml_response(index),
            "/post-sitemap.xml": xml_response("<oops"),
            "/post2.xml": xml_response(urlset([("https://example-blog.com/dal/", None)])),
        }
        assert [e.url for e in find(files)] == ["https://example-blog.com/dal/"]
