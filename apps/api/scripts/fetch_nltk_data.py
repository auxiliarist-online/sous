"""Download the NLTK data ingredient-parser-nlp needs into apps/api/nltk_data.

The parser would otherwise download it on first use, which fails on Vercel
(read-only file system) and slows every cold start. Run at build time
([tool.vercel.scripts] in pyproject.toml), in CI, and once locally.
"""

from pathlib import Path

import nltk

DATA = Path(__file__).resolve().parents[1] / "nltk_data"
PACKAGES = ["averaged_perceptron_tagger_eng"]

if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    for package in PACKAGES:
        if not nltk.download(package, download_dir=str(DATA), quiet=True):
            raise SystemExit(f"could not download NLTK package {package}")
    print(f"NLTK data ready in {DATA}")
