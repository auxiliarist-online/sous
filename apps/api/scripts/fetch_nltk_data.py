"""Download the NLTK data ingredient-parser-nlp needs into apps/api/nltk_data.

The parser would otherwise download it on first use, which fails on Vercel
(read-only file system) and slows every cold start. Run at build time
([tool.vercel.scripts] in pyproject.toml), in CI, and once locally.

Standard library only: Vercel's build step may run a Python that can't see
the app's installed packages, so this mustn't import nltk.
"""

import io
import sys
import urllib.request
import zipfile
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "nltk_data"
# Same files nltk.download() fetches (https://www.nltk.org/nltk_data/).
BASE = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages"
PACKAGES = {"averaged_perceptron_tagger_eng": "taggers"}


def fetch(name: str, folder: str) -> None:
    target = DATA / folder
    if (target / name).is_dir():
        print(f"{folder}/{name}: already there")
        return
    url = f"{BASE}/{folder}/{name}.zip"
    with urllib.request.urlopen(url, timeout=60) as resp:
        payload = resp.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        bad = zf.testzip()
        if bad:
            raise ValueError(f"corrupt file {bad} in {url}")
        target.mkdir(parents=True, exist_ok=True)
        zf.extractall(target)
    print(f"{folder}/{name}: downloaded ({len(payload) // 1024} KB)")


if __name__ == "__main__":
    try:
        for name, folder in PACKAGES.items():
            fetch(name, folder)
    except Exception as e:  # say exactly what failed in the build log
        sys.exit(f"fetch_nltk_data: {type(e).__name__}: {e} (python {sys.executable})")
    print(f"NLTK data ready in {DATA}")
