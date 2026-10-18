"""A static map of the lower 48: states, 25- and 10-mile coverage, stores."""
import sys
from pathlib import Path
import geopandas as gpd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
HERE = Path(__file__).parent / "data"; OUT = HERE / "out"
st = gpd.read_file(f"zip://{HERE / 'census/states.zip'}")
st = st[~st.STUSPS.isin(["AK", "HI", "PR"])].to_crs(5070)
c25 = gpd.read_file(OUT / "coverage_25mi.shp").to_crs(5070).clip(st)
c10 = gpd.read_file(OUT / "coverage_10mi.shp").to_crs(5070).clip(st)
s = gpd.read_file(OUT / "kroger_stores.shp").to_crs(5070).clip(st)
fig, ax = plt.subplots(figsize=(16, 10))
st.plot(ax=ax, color="#f1efe9", edgecolor="#b9b4a8", linewidth=0.6)
c25.plot(ax=ax, color="#b9d8c2", linewidth=0)
c10.plot(ax=ax, color="#4f9a6b", linewidth=0)
s.plot(ax=ax, color="#1d3b2a", markersize=1.2)
st.boundary.plot(ax=ax, color="#8f897c", linewidth=0.5)
ax.set_axis_off()
fig.savefig(OUT / "coverage_map.png", dpi=110, bbox_inches="tight")
