"""Kroger-family store coverage of the US population: shapefiles, a map,
and tables of the gaps, from stores.json and Census 2020 tract centers."""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd, geopandas as gpd
from scipy.spatial import cKDTree
from shapely.geometry import Point

HERE = Path(__file__).parent / "data"; OUT = HERE / "out"; C = HERE / "census"
R_MI = 3958.8
BANNERS = {"KROGER": "Kroger", "HART": "Harris Teeter", "RALPHS": "Ralphs", "SMITHS": "Smith's",
           "FRYS": "Fry's", "FRED": "Fred Meyer", "KINGSOOPERS": "King Soopers", "FOOD4LESS": "Food 4 Less",
           "PICK N SAVE": "Pick 'n Save", "DILLONS": "Dillons", "QFC": "QFC", "RULER": "Ruler Foods",
           "MARIANOS": "Mariano's", "CITYMARKET": "City Market", "METRO MARKET": "Metro Market",
           "JAYC": "Jay C", "FOODSCO": "Foods Co", "BAKERS": "Baker's", "PAYLESS": "Pay Less", "GERBES": "Gerbes"}

raw = [s for s in json.loads((HERE / "stores.json").read_text()) if s["chain"] in BANNERS]
stores = gpd.GeoDataFrame(
    {"loc_id": [s["locationId"] for s in raw],
     "banner": [BANNERS[s["chain"]] for s in raw],
     "sous": ["harris_teeter" if s["chain"] == "HART" else "kroger" for s in raw],
     "city": [s["address"]["city"] for s in raw], "state": [s["address"]["state"] for s in raw],
     "zip": [s["address"]["zipCode"] for s in raw]},
    geometry=[Point(s["geolocation"]["longitude"], s["geolocation"]["latitude"]) for s in raw], crs=4326)

def xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.c_[np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)]

tracts = pd.read_csv(C / "tracts.txt", dtype={"STATEFP": str, "COUNTYFP": str, "TRACTCE": str}, encoding="utf-8-sig")
tracts = tracts[tracts.STATEFP.astype(int) <= 56]  # states + DC (no territories)
tree = cKDTree(xyz(stores.geometry.y.values, stores.geometry.x.values))
chord, _ = tree.query(xyz(tracts.LATITUDE.values, tracts.LONGITUDE.values))
tracts["miles"] = 2 * R_MI * np.arcsin(np.clip(chord / 2, 0, 1))

states = gpd.read_file(f"zip://{C / 'states.zip'}").to_crs(4326)
fips = states.set_index("STATEFP")[["STUSPS", "NAME"]]
tracts["state"] = tracts.STATEFP.map(fips.STUSPS)
pop = tracts.POPULATION.sum()

def share(df, miles): return df.loc[df.miles <= miles, "POPULATION"].sum() / max(df.POPULATION.sum(), 1)

national = {f"within_{m}mi": round(100 * share(tracts, m), 1) for m in (5, 10, 25)}
national.update(population=int(pop), stores=len(stores),
                sous_kroger=int((stores.sous == "kroger").sum()), sous_harris_teeter=int((stores.sous == "harris_teeter").sum()))

by_state = (tracts.groupby("state").apply(lambda d: pd.Series({
    "population": int(d.POPULATION.sum()),
    "pct_5mi": round(100 * share(d, 5), 1), "pct_10mi": round(100 * share(d, 10), 1), "pct_25mi": round(100 * share(d, 25), 1),
    "uncovered_10mi": int(d.loc[d.miles > 10, "POPULATION"].sum())}), include_groups=False)
    .join(stores.groupby("state").size().rename("stores")).fillna({"stores": 0}).astype({"stores": int})
    .sort_values("population", ascending=False))

cb = pd.read_excel(C / "cbsa.xlsx", header=2, dtype=str)
cb = cb[cb["Metropolitan/Micropolitan Statistical Area"] == "Metropolitan Statistical Area"]
cb["county"] = cb["FIPS State Code"] + cb["FIPS County Code"]
tracts["county"] = tracts.STATEFP + tracts.COUNTYFP
t = tracts.merge(cb[["county", "CBSA Title"]], on="county", how="left")
metros = (t.dropna(subset=["CBSA Title"]).groupby("CBSA Title").apply(lambda d: pd.Series({
    "population": int(d.POPULATION.sum()), "pct_10mi": round(100 * share(d, 10), 1),
    "pct_25mi": round(100 * share(d, 25), 1),
    "median_miles": round(float(np.median(np.repeat(d.miles.values, np.maximum(d.POPULATION.values // 100, 1)))), 1)}),
    include_groups=False).sort_values("population", ascending=False))
metros["uncovered_10mi"] = (metros.population * (100 - metros.pct_10mi) / 100).round().astype(int)

# Shapefiles (WGS84), coverage dissolved in an equal-area projection and kept to land.
land = states[states.STATEFP.astype(int) <= 56].to_crs(5070).union_all()
def coverage(miles):
    area = stores.to_crs(5070).buffer(miles * 1609.344).union_all().intersection(land)
    return gpd.GeoDataFrame({"miles": [miles]}, geometry=[area], crs=5070).to_crs(4326)
OUT.mkdir(parents=True, exist_ok=True)
stores.to_file(OUT / "kroger_stores.shp")
coverage(10).to_file(OUT / "coverage_10mi.shp")
coverage(25).to_file(OUT / "coverage_25mi.shp")
gaps = tracts[tracts.miles > 25]
gpd.GeoDataFrame(gaps[["state", "county", "TRACTCE", "POPULATION", "miles"]].rename(columns={"POPULATION": "pop", "TRACTCE": "tract"}),
                 geometry=gpd.points_from_xy(gaps.LONGITUDE, gaps.LATITUDE), crs=4326).to_file(OUT / "uncovered_tracts_25mi.shp")

by_state.to_csv(OUT / "coverage_by_state.csv"); metros.to_csv(OUT / "coverage_by_metro.csv")
(OUT / "summary.json").write_text(json.dumps(national, indent=1))
print(json.dumps(national))
print(by_state.head(51).to_string())
print(metros.head(60).to_string())
