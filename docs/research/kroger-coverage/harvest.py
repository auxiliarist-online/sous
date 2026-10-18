"""Collect every Kroger-family store from the Locations API by sweeping a hex
grid of 100-mile searches over the US, splitting any search that returns the
200-result cap (Kroger's reported total is capped too, so it can't show a cut
off search). Responses are cached in data/cache; stores go to data/stores.json.

    cd apps/api && set -a && . ../../.env && set +a   # KROGER_CLIENT_ID/SECRET
    .venv/bin/python ../../docs/research/kroger-coverage/harvest.py

About 420 Locations calls (the API allows 1,600 a day). data/ is gitignored:
Kroger's store data isn't kept in the repo."""
import json, math, os, sys, hashlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps" / "api"))
import httpx2 as httpx
from app.config import settings
settings.kroger_client_id = os.environ["KROGER_CLIENT_ID"]
settings.kroger_client_secret = os.environ["KROGER_CLIENT_SECRET"]
from app.pricing.kroger import Kroger

HERE = Path(__file__).parent / "data"
(HERE / "cache").mkdir(parents=True, exist_ok=True)
k = Kroger(httpx.Client(timeout=30))
calls = 0
stores: dict[str, dict] = {}

def query(lat, lon, miles):
    global calls
    key = hashlib.sha1(f"{lat:.4f},{lon:.4f},{miles}".encode()).hexdigest()
    f = HERE / "cache" / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text())
    calls += 1
    r = k._get("locations", {"filter.latLong.near": f"{lat:.4f},{lon:.4f}",
                             "filter.radiusInMiles": miles, "filter.limit": 200})
    body = {"data": [], "meta": {}} if r.status_code == 404 else r.json()
    if r.status_code not in (200, 404):
        raise SystemExit(f"{r.status_code} {r.text[:200]}")
    f.write_text(json.dumps(body))
    return body

def sweep(lat, lon, miles, depth=0):
    body = query(lat, lon, miles)
    for s in body.get("data") or []:
        stores[s["locationId"]] = {k2: s.get(k2) for k2 in ("locationId", "chain", "name", "address", "geolocation")}
    total = ((body.get("meta") or {}).get("pagination") or {}).get("total", 0)
    if len(body.get("data") or []) >= 200 and miles > 5:
        # Hit the cap: cover the same circle with 7 smaller ones.
        r = miles / 2
        for i in range(7):
            if i == 0: dlat = dlon = 0.0
            else:
                a = math.radians(60 * i)
                dist = r * 1.6
                dlat = dist * math.cos(a) / 69.0
                dlon = dist * math.sin(a) / (69.0 * math.cos(math.radians(lat)))
            sweep(lat + dlat, lon + dlon, int(math.ceil(r)), depth + 1)

def grid(lat0, lat1, lon0, lon1, spacing):
    row = 0; lat = lat0
    while lat <= lat1:
        step = spacing / (69.0 * math.cos(math.radians(lat)))
        lon = lon0 + (step / 2 if row % 2 else 0)
        while lon <= lon1:
            yield lat, lon
            lon += step
        lat += spacing * 0.866 / 69.0; row += 1

points = list(grid(24.4, 49.5, -125.0, -66.8, 140))          # lower 48
points += list(grid(55.0, 65.0, -165.0, -140.0, 140))        # Alaska
points += list(grid(54.5, 60.5, -140.0, -129.5, 140))        # Alaska's panhandle (Juneau)
points += [(21.4, -157.9), (20.8, -156.3), (19.6, -155.5)]   # Hawaii
print("grid points:", len(points), file=sys.stderr)
for i, (lat, lon) in enumerate(points):
    sweep(lat, lon, 100)
    if calls > 1400:
        print("stopping: near the daily limit", file=sys.stderr); break
(HERE / "stores.json").write_text(json.dumps(list(stores.values())))
print(f"calls made: {calls}, stores: {len(stores)}", file=sys.stderr)
