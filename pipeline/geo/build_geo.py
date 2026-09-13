#!/usr/bin/env python3
"""One-off: build the site's simplified map shapes from Natural Earth.

Usage:
  python pipeline/geo/build_geo.py ne_50m_admin_0_countries.geojson ne_10m_admin_1_states_provinces.geojson

Needs mapshaper (npm i -g mapshaper, or set MAPSHAPER="npx mapshaper"). Run it after
pipeline/build.py, because it reads docs/data/subregions/ to decide, per country, which
Natural Earth field best matches Anthropic's ISO 3166-2 subregion codes.
Natural Earth data is public domain: https://www.naturalearthdata.com
"""
import collections
import glob
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GEO_OUT = os.path.join(ROOT, "docs", "geo")
MAPSHAPER = shlex.split(os.environ.get("MAPSHAPER", "mapshaper"))
FIELDS = ["iso_3166_2", "region_cod", "gn_a1_code", "code_hasc"]
GB_NATIONS = {"England": "GB-ENG", "Scotland": "GB-SCT", "Wales": "GB-WLS", "Northern Ireland": "GB-NIR"}
# ISO switched Polish voivodeships from letter to number codes; Natural Earth still uses letters.
PL_VOIVODESHIPS = {
    "PL-DS": "PL-02", "PL-KP": "PL-04", "PL-LU": "PL-06", "PL-LB": "PL-08", "PL-LD": "PL-10",
    "PL-MA": "PL-12", "PL-MZ": "PL-14", "PL-OP": "PL-16", "PL-PK": "PL-18", "PL-PD": "PL-20",
    "PL-PM": "PL-22", "PL-SL": "PL-24", "PL-SK": "PL-26", "PL-WN": "PL-28", "PL-WP": "PL-30",
    "PL-ZP": "PL-32",
}


def norm(value):
    return str(value or "").replace(".", "-").upper()


def keyers(cc):
    """Candidate ways to turn a Natural Earth feature into (subregion code, display name)."""
    def by_field(field):
        def key(p):
            label = p.get("region") if field == "region_cod" else (p.get("name") or p.get("name_en"))
            return norm(p.get(field)), label
        return key

    out = {field: by_field(field) for field in FIELDS}
    if cc == "GB":
        out["geonunit"] = lambda p: (GB_NATIONS.get(p.get("geonunit"), ""), p.get("geonunit"))
    if cc == "PL":
        out["pl_numeric"] = lambda p: (PL_VOIVODESHIPS.get(norm(p.get("iso_3166_2")), ""), p.get("name_en") or p.get("name"))
    return out


def run(args):
    subprocess.run(MAPSHAPER + args, check=True, stdout=subprocess.DEVNULL)


def main():
    admin0, admin1 = sys.argv[1:3]
    os.makedirs(os.path.join(GEO_OUT, "admin1"), exist_ok=True)
    run([admin0, "-filter", "ADM0_A3 !== 'ATA'",
         "-each", "iso3 = ISO_A3_EH !== '-99' ? ISO_A3_EH : ADM0_A3, name = NAME",
         "-filter-fields", "iso3,name", "-simplify", "20%", "keep-shapes",
         "-rename-layers", "countries",
         "-o", os.path.join(GEO_OUT, "world.json"), "format=topojson", "quantization=100000", "force"])

    wanted = collections.defaultdict(set)
    for path in glob.glob(os.path.join(ROOT, "docs", "data", "subregions", "*.json")):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for period in data["p"].values():
            wanted[os.path.basename(path)[:-5]].update(period)

    with open(admin1, encoding="utf-8") as fh:
        features = collections.defaultdict(list)
        for feat in json.load(fh)["features"]:
            features[feat["properties"].get("iso_a2")].append(feat)

    index, tmp = {}, tempfile.mkdtemp()
    for cc, codes in sorted(wanted.items()):
        if not features.get(cc):
            continue
        field, keyer = max(keyers(cc).items(),
                           key=lambda kv: len(codes & {kv[1](f["properties"])[0] for f in features[cc]}))
        out = []
        for feat in features[cc]:
            code, label = keyer(feat["properties"])
            hit = code in codes
            out.append({"type": "Feature", "geometry": feat["geometry"],
                        "properties": {"code": code if hit else "", "name": (label or code) if hit else ""}})
        matched = len(codes & {f["properties"]["code"] for f in out})
        if not matched:
            continue
        src = os.path.join(tmp, f"{cc}.geojson")
        with open(src, "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": out}, fh)
        run([src, "-dissolve", "code", "copy-fields=name", "-simplify", "8%", "keep-shapes",
             "-rename-layers", "subregions",
             "-o", os.path.join(GEO_OUT, "admin1", f"{cc}.json"), "format=topojson", "quantization=100000", "force"])
        index[cc] = {"matched": matched, "total": len(codes), "field": field}
        print(f"{cc}: {matched}/{len(codes)} via {field}")
    shutil.rmtree(tmp)
    with open(os.path.join(GEO_OUT, "admin1", "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
