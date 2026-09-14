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
# Natural Earth still uses pre-reform or finer-grained codes in several countries. These map
# them to the ISO 3166-2 codes Anthropic publishes: straight renames, plus groups of Natural
# Earth areas that dissolve into one published region.
def _group(target, *sources):
    return {source: target for source in sources}


ALIASES = {
    "MX-DIF": "MX-CMX",  # Mexico City: ISO code changed in 2017
    "IN-TG": "IN-TS", "IN-OR": "IN-OD", "IN-CT": "IN-CG", "IN-UT": "IN-UK",
    "TW-TPQ": "TW-NWT", "ZA-GT": "ZA-GP", "ZA-NL": "ZA-KZN", "KE-110": "KE-30",
    "ES-PM": "ES-IB", "ES-MU": "ES-MC", "ES-NA": "ES-NC", "ES-LO": "ES-RI",
    # Polish voivodeships moved from letter to number codes.
    "PL-DS": "PL-02", "PL-KP": "PL-04", "PL-LU": "PL-06", "PL-LB": "PL-08", "PL-LD": "PL-10",
    "PL-MA": "PL-12", "PL-MZ": "PL-14", "PL-OP": "PL-16", "PL-PK": "PL-18", "PL-PD": "PL-20",
    "PL-PM": "PL-22", "PL-SL": "PL-24", "PL-SK": "PL-26", "PL-WN": "PL-28", "PL-WP": "PL-30",
    "PL-ZP": "PL-32",
    # Czech regions moved from letter to number codes.
    "CZ-PR": "CZ-10", "CZ-ST": "CZ-20", "CZ-JC": "CZ-31", "CZ-PL": "CZ-32", "CZ-KA": "CZ-41",
    "CZ-US": "CZ-42", "CZ-LI": "CZ-51", "CZ-KR": "CZ-52", "CZ-PA": "CZ-53", "CZ-VY": "CZ-63",
    "CZ-JM": "CZ-64", "CZ-OL": "CZ-71", "CZ-ZL": "CZ-72", "CZ-MO": "CZ-80",
    **_group("FR-IDF", "FR-75", "FR-77", "FR-78", "FR-91", "FR-92", "FR-93", "FR-94", "FR-95"),
    **_group("FR-20R", "FR-2A", "FR-2B"),
    **_group("BE-VLG", "BE-VAN", "BE-VBR", "BE-VLI", "BE-VOV", "BE-VWV"),
    **_group("BE-WAL", "BE-WBR", "BE-WHT", "BE-WLG", "BE-WLX", "BE-WNA"),
    **_group("IE-L", "IE-D", "IE-CW", "IE-KE", "IE-KK", "IE-LS", "IE-LD", "IE-LH", "IE-MH", "IE-OY", "IE-WH", "IE-WX", "IE-WW"),
    **_group("IE-M", "IE-CE", "IE-CO", "IE-KY", "IE-LK", "IE-TA", "IE-WD"),
    **_group("IE-C", "IE-G", "IE-LM", "IE-MO", "IE-RN", "IE-SO"),
    **_group("IE-U", "IE-CN", "IE-DL", "IE-MN"),
    **_group("ID-JW", "ID-JK", "ID-JB", "ID-JT", "ID-JI", "ID-BT", "ID-YO"),
    **_group("ID-SM", "ID-AC", "ID-SU", "ID-SB", "ID-RI", "ID-KR", "ID-JA", "ID-SS", "ID-BB", "ID-BE", "ID-LA"),
    **_group("ID-KA", "ID-KB", "ID-KT", "ID-KS", "ID-KI", "ID-KU"),
    **_group("ID-NU", "ID-BA", "ID-NB", "ID-NT"),
    **_group("ID-PP", "ID-PA", "ID-PB"),
    **_group("ID-ML", "ID-MA", "ID-MU"),
    **_group("ID-SL", "ID-SA", "ID-ST", "ID-SN", "ID-SG", "ID-GO", "ID-SR"),
    # Norway's 2020 county mergers.
    **_group("NO-30", "NO-01", "NO-02", "NO-06"), **_group("NO-34", "NO-04", "NO-05"),
    **_group("NO-38", "NO-07", "NO-08"), **_group("NO-42", "NO-09", "NO-10"),
    **_group("NO-46", "NO-12", "NO-14"), **_group("NO-50", "NO-16", "NO-17"),
    **_group("NO-54", "NO-19", "NO-20"),
}
# Capital districts that Natural Earth files under the surrounding region's code.
NAME_ALIASES = {("CO", "Bogota"): "CO-DC", ("PE", "Lima Province"): "PE-LMA"}
GROUP_NAMES = {
    "MX-CMX": "Ciudad de México", "CO-DC": "Bogotá", "PE-LMA": "Lima Metropolitana", "KE-30": "Nairobi",
    "FR-IDF": "Île-de-France", "FR-20R": "Corse", "BE-VLG": "Flanders", "BE-WAL": "Wallonia",
    "IE-L": "Leinster", "IE-M": "Munster", "IE-C": "Connacht", "IE-U": "Ulster",
    "ID-JW": "Java", "ID-SM": "Sumatra", "ID-KA": "Kalimantan", "ID-NU": "Nusa Tenggara",
    "ID-PP": "Papua", "ID-ML": "Maluku", "ID-SL": "Sulawesi",
    "NO-30": "Viken", "NO-34": "Innlandet", "NO-38": "Vestfold og Telemark", "NO-42": "Agder",
    "NO-46": "Vestland", "NO-50": "Trøndelag", "NO-54": "Troms og Finnmark",
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
    return out


def resolve(cc, props, code, label, wanted):
    """Prefer an explicit capital-district alias, then the field's own code, then code aliases."""
    named = NAME_ALIASES.get((cc, props.get("name")))
    if named in wanted:
        return named, GROUP_NAMES.get(named, props.get("name"))
    if code in wanted:
        return code, GROUP_NAMES.get(code, label)
    for alt in (ALIASES.get(norm(props.get("iso_3166_2"))), ALIASES.get(code)):
        if alt in wanted:
            return alt, GROUP_NAMES.get(alt, label)
    return code, label


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
                           key=lambda kv: len(codes & {resolve(cc, f["properties"], *kv[1](f["properties"]), codes)[0]
                                                       for f in features[cc]}))
        out = []
        for feat in features[cc]:
            code, label = resolve(cc, feat["properties"], *keyer(feat["properties"]), codes)
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
