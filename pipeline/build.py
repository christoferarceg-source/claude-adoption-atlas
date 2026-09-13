#!/usr/bin/env python3
"""Rebuild the atlas's adoption data from Anthropic's Economic Index on Hugging Face.

Each release's Claude.ai file is streamed once and reduced to a small cache file in
pipeline/cache/. Later runs reuse that cache and only download releases whose source
file changed, so the daily job is cheap until Anthropic publishes something new.
"""
import collections
import csv
import io
import json
import math
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "pipeline", "reference")
CACHE = os.path.join(ROOT, "pipeline", "cache")
OUT = os.path.join(ROOT, "docs", "data")
HF = "https://huggingface.co"
DATASET = "Anthropic/EconomicIndex"
CACHE_VERSION = 1

# Claude is not offered in these countries, so missing data there is not low demand.
UNSUPPORTED = ["CHN", "CUB", "IRN", "PRK", "RUS", "SYR"]
# Most specific file first: enriched (2025-09), current schema (2026-06+), raw (2026-01/03).
FILE_PATTERNS = [
    re.compile(r"/aei_enriched_claude_ai_[^/]*\.csv$"),
    re.compile(r"/aei_claude_ai_[^/]*\.csv$"),
    re.compile(r"/aei_raw_claude_ai_[^/]*\.csv$"),
]
CODING_TOPICS = {"Software Development", "DevOps & Infrastructure Operations"}
AUTOMATION = {"directive", "feedback loop", "feedback_loop"}
AUGMENTATION = {"task iteration", "task_iteration", "learning", "validation"}
USE_CASES = ("work", "personal", "coursework")
MIN_COUNTRIES = 50

EAST_ASIA = {"CHN", "JPN", "KOR", "TWN", "HKG", "MNG", "MAC", "PRK"}
SOUTH_ASIA = {"IND", "PAK", "BGD", "LKA", "NPL", "BTN", "MDV", "AFG"}
SOUTHEAST_ASIA = {"IDN", "THA", "VNM", "PHL", "MYS", "SGP", "MMR", "KHM", "LAO", "BRN", "TLS"}
EUROPE_CENTRAL_ASIA = {"KAZ", "UZB", "KGZ", "TJK", "TKM", "ARM", "GEO", "AZE", "RUS", "TUR", "CYP"}
NORTH_AFRICA = {"EGY", "MAR", "DZA", "TUN", "LBY", "SDN"}

csv.field_size_limit(sys.maxsize)


def request(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "claude-adoption-atlas"})
    return urllib.request.urlopen(req, timeout=timeout)


def get_json(url):
    with request(url, 120) as resp:
        return json.load(resp)


def stream_csv(path):
    resp = request(f"{HF}/datasets/{DATASET}/resolve/main/{path}", 900)
    return csv.DictReader(io.TextIOWrapper(resp, encoding="utf-8", newline=""))


def load_reference():
    def rows(name):
        with open(os.path.join(REF, name), encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    pop = {r["iso_alpha_3"]: float(r["working_age_pop"]) for r in rows("working_age_pop_2024_country.csv")}
    gdp = {r["iso_alpha_3"]: float(r["gdp_total"]) for r in rows("gdp_2024_country.csv")}
    names, a2to3 = {}, {}
    for r in rows("iso_country_codes.csv"):
        a2to3[r["iso_alpha_2"]] = r["iso_alpha_3"]
        names[r["iso_alpha_3"]] = r["country_name"]
    continent = {}
    with open(os.path.join(REF, "geonames_countryInfo.txt"), encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) > 8:
                continent[parts[1]] = parts[8]
                names.setdefault(parts[1], parts[4])
    return {"pop": pop, "gdp": gdp, "names": names, "a2to3": a2to3, "continent": continent}


def region_of(iso3, continent):
    c = continent.get(iso3)
    if iso3 in ("USA", "CAN"):
        return "North America"
    if c in ("NA", "SA"):
        return "Latin America & Caribbean"
    if iso3 in EUROPE_CENTRAL_ASIA or c == "EU":
        return "Europe & Central Asia"
    if iso3 in EAST_ASIA:
        return "East Asia"
    if iso3 in SOUTH_ASIA:
        return "South Asia"
    if iso3 in SOUTHEAST_ASIA:
        return "Southeast Asia"
    if iso3 in NORTH_AFRICA or c == "AS":
        return "Middle East & North Africa"
    if c == "AF":
        return "Sub-Saharan Africa"
    if c == "OC":
        return "Oceania"
    return "Other"


def list_release_files():
    """Pick one Claude.ai geography file per release folder."""
    tree = get_json(f"{HF}/api/datasets/{DATASET}/tree/main?recursive=true")
    by_release = collections.defaultdict(list)
    for entry in tree:
        if entry.get("type") == "file" and entry["path"].startswith("release_"):
            by_release[entry["path"].split("/")[0]].append(entry)
    chosen = {}
    for release, entries in by_release.items():
        for pattern in FILE_PATTERNS:
            hits = sorted((e for e in entries if pattern.search("/" + e["path"])), key=lambda e: e["path"])
            if hits:
                e = hits[-1]
                chosen[release] = {"path": e["path"], "oid": (e.get("lfs") or {}).get("oid") or e.get("oid")}
                break
    return chosen


def new_period(kind):
    return {"kind": kind, "countries": collections.defaultdict(dict), "subregions": collections.defaultdict(dict)}


def to_iso3(geo_id, a2to3):
    if len(geo_id) == 3:
        return geo_id
    return a2to3.get(geo_id)


def sub_code(geo_id, geography, a3to2):
    if "-" in geo_id:
        prefix, rest = geo_id.split("-", 1)
        if len(prefix) == 3:
            prefix = a3to2.get(prefix, prefix)
        return f"{prefix}-{rest}"
    if "us" in geography.lower():
        return f"US-{geo_id}"
    return None


def reduce_legacy(rows, ref):
    """Schema used through the March 2026 release (facet / variable / cluster_name)."""
    a3to2 = {v: k for k, v in ref["a2to3"].items()}
    periods = collections.defaultdict(lambda: new_period("one-week sample"))
    collab = collections.defaultdict(dict)
    for r in rows:
        geo = r["geography"]
        if geo == "global" or not r["value"]:
            continue
        pid, facet, var, cluster = r["date_start"], r["facet"], r["variable"], r["cluster_name"]
        val = float(r["value"])
        if geo == "country":
            iso = to_iso3(r["geo_id"], ref["a2to3"])
            if not iso:
                continue
            m = periods[pid]["countries"][iso]
            if facet == "country" and var == "usage_count":
                m["n"] = val
            elif facet == "use_case" and var == "use_case_pct" and cluster in USE_CASES:
                m["uc_" + cluster] = val
            elif facet == "collaboration" and var == "collaboration_pct":
                collab[(pid, iso)][cluster] = val
        elif facet == geo:
            code = sub_code(r["geo_id"], geo, a3to2)
            if code and var == "usage_pct":
                periods[pid]["subregions"][code]["share"] = val
    for (pid, iso), clusters in collab.items():
        auto = sum(v for k, v in clusters.items() if k in AUTOMATION)
        aug = sum(v for k, v in clusters.items() if k in AUGMENTATION)
        if auto + aug:
            periods[pid]["countries"][iso]["automation"] = 100 * auto / (auto + aug)
    return periods


def reduce_v6(rows):
    """Schema introduced in the June 2026 release (geo_level / category_name / metric_id)."""
    periods = collections.defaultdict(lambda: new_period("calendar month"))
    for r in rows:
        level, cat, metric, pid = r["geo_level"], r["category_name"], r["metric_id"], r["date_start"]
        if level not in ("country", "subregion") or not r["value"]:
            continue
        is_coding = (cat == "request" and level == "country" and metric == "pct"
                     and r["hierarchy_level"] == "2" and r["node_name"] in CODING_TOPICS)
        if cat != "overall" and not is_coding:
            continue
        val = float(r["value"])
        bucket = "countries" if level == "country" else "subregions"
        m = periods[pid][bucket][r["geo_id"]]
        if is_coding:
            m["coding"] = m.get("coding", 0.0) + val
        elif metric == "usage_pct":
            m["n" if level == "country" else "share"] = val
        elif metric == "usage_per_capita_index" and level == "subregion":
            m["aui"] = val
        elif metric.startswith("use_case_") and metric.endswith("_pct"):
            m["uc_" + metric[len("use_case_"):-len("_pct")]] = val
        elif metric == "collaboration_bucket_automation_pct":
            m["auto_raw"] = val
        elif metric == "collaboration_bucket_augmentation_pct":
            m["aug_raw"] = val
    return periods


def finalize(periods):
    out = {}
    for pid, p in periods.items():
        groups = {}
        for bucket in ("countries", "subregions"):
            clean = {}
            for geo_id, m in p[bucket].items():
                rec = {k: m[k] for k in ("n", "share", "aui", "coding", "automation") if k in m}
                uc = {k: m.get("uc_" + k) for k in USE_CASES}
                total = sum(v for v in uc.values() if v is not None)
                if total and all(v is not None for v in uc.values()):
                    rec.update({k: 100 * v / total for k, v in uc.items()})
                if "auto_raw" in m and "aug_raw" in m and m["auto_raw"] + m["aug_raw"]:
                    rec["automation"] = 100 * m["auto_raw"] / (m["auto_raw"] + m["aug_raw"])
                if rec:
                    clean[geo_id] = rec
            groups[bucket] = clean
        out[pid] = {"kind": p["kind"], **groups}
    return out


def process_release(path, ref):
    rows = stream_csv(path)
    cols = set(rows.fieldnames or [])
    if {"geo_level", "metric_id", "category_name"} <= cols:
        return finalize(reduce_v6(rows))
    if {"geography", "facet", "variable", "cluster_name"} <= cols:
        return finalize(reduce_legacy(rows, ref))
    raise SystemExit(f"Unrecognised schema in {path}: {sorted(cols)}. Update pipeline/build.py.")


def gini(values):
    xs = sorted(values)
    n, total = len(xs), sum(xs)
    if n == 0 or total == 0:
        return None
    return sum((2 * i - n + 1) * x for i, x in enumerate(xs)) / (n * total)


def log_fit(points):
    n = len(points)
    if n < 3:
        return None
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    syy = sum((p[1] - my) ** 2 for p in points)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points)
    slope = sxy / sxx
    return {"slope": round(slope, 3), "intercept": round(my - slope * mx, 3), "r2": round(sxy * sxy / (sxx * syy), 3)}


def assemble(releases, ref):
    pop, gdp = ref["pop"], ref["gdp"]
    a3to2 = {v: k for k, v in ref["a2to3"].items()}
    merged = {}
    for release in sorted(releases):
        for pid, pdata in releases[release]["periods"].items():
            merged[pid] = dict(pdata, release=release)  # a later release wins for the same period
    pids = sorted(merged)

    countries, summary = {}, {}
    regions = collections.defaultdict(lambda: {"p": {}})
    subregions = collections.defaultdict(lambda: {"p": {}})
    for pid in pids:
        cdata = merged[pid]["countries"]
        valid = [c for c, m in cdata.items() if c in pop and m.get("n")]
        total = sum(cdata[c]["n"] for c in valid)
        pop_total = sum(pop[c] for c in valid)
        region_acc = collections.defaultdict(lambda: [0.0, 0.0])
        for iso in valid:
            m = cdata[iso]
            share = 100 * m["n"] / total
            rec = {"share": round(share, 3), "aui": round((m["n"] / total) / (pop[iso] / pop_total), 3)}
            for k in ("work", "personal", "coursework", "automation", "coding"):
                if m.get(k) is not None:
                    rec[k] = round(m[k], 1)
            entry = countries.setdefault(iso, {
                "name": ref["names"].get(iso, iso),
                "iso2": a3to2.get(iso),
                "region": region_of(iso, ref["continent"]),
                "gdp_pc": round(gdp[iso] / pop[iso]) if iso in gdp else None,
                "p": {},
            })
            entry["p"][pid] = rec
            region_acc[entry["region"]][0] += share
            region_acc[entry["region"]][1] += pop[iso]
        for name, (share, rpop) in region_acc.items():
            regions[name]["p"][pid] = {"share": round(share, 2), "aui": round((share / 100) / (rpop / pop_total), 3)}

        for code, m in merged[pid]["subregions"].items():
            rec = {k: round(v, 2) for k, v in m.items() if k in ("share", "aui", "work", "personal", "coursework", "automation")}
            if rec:
                subregions[code.split("-")[0]]["p"].setdefault(pid, {})[code] = rec

        auis = [countries[c]["p"][pid]["aui"] for c in valid]
        top20 = sum(sorted(auis, reverse=True)[:20]) / sum(auis) * 100 if auis else None
        fit_points = [(math.log10(gdp[c] / pop[c]), math.log10(countries[c]["p"][pid]["aui"]))
                      for c in valid if c in gdp and countries[c]["p"][pid]["aui"] > 0]
        summary[pid] = {"countries": len(valid), "gini": round(gini(auis), 3) if auis else None,
                        "top20": round(top20, 1) if top20 else None, "fit": log_fit(fit_points)}

    latest = pids[-1]
    if summary[latest]["countries"] < MIN_COUNTRIES:
        raise SystemExit(f"Only {summary[latest]['countries']} countries in {latest}; refusing to publish.")

    periods = []
    for pid in pids:
        label = f"{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][int(pid[5:7]) - 1]} {pid[:4]}"
        periods.append({"id": pid, "label": label, "kind": merged[pid]["kind"], "release": merged[pid]["release"]})
    aei = {
        "periods": periods,
        "countries": dict(sorted(countries.items())),
        "regions": dict(sorted(regions.items())),
        "summary": summary,
        "unsupported": UNSUPPORTED,
        "countries_with_subregions": sorted(subregions),
        "unsupported_regions": {iso: region_of(iso, ref["continent"]) for iso in UNSUPPORTED},
    }
    return aei, subregions


def write_json(path, obj):
    """Write only when content changes, so unchanged data doesn't create commits."""
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            if fh.read() == text:
                return False
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return True


def main():
    ref = load_reference()
    files = list_release_files()
    if not files:
        raise SystemExit("No Claude.ai geography files found in the dataset.")
    os.makedirs(CACHE, exist_ok=True)
    releases = {}
    for release, meta in sorted(files.items()):
        cache_path = os.path.join(CACHE, release + ".json")
        cached = None
        if os.path.exists(cache_path):
            with open(cache_path, encoding="utf-8") as fh:
                cached = json.load(fh)
        if not cached or cached.get("oid") != meta["oid"] or cached.get("version") != CACHE_VERSION:
            print(f"Processing {meta['path']}", flush=True)
            cached = {"version": CACHE_VERSION, "oid": meta["oid"], "path": meta["path"],
                      "periods": process_release(meta["path"], ref)}
            write_json(cache_path, cached)
        else:
            print(f"Cached {meta['path']}")
        releases[release] = cached

    aei, subregions = assemble(releases, ref)
    os.makedirs(os.path.join(OUT, "subregions"), exist_ok=True)
    changed = write_json(os.path.join(OUT, "aei.json"), aei)
    for iso2, data in subregions.items():
        changed |= write_json(os.path.join(OUT, "subregions", f"{iso2}.json"), data)
    sources = {"dataset": f"{HF}/datasets/{DATASET}", "files": [releases[r]["path"] for r in sorted(releases)],
               "latest_period": aei["periods"][-1]["id"]}
    changed |= write_json(os.path.join(OUT, "sources.json"), sources)
    print(f"{len(aei['periods'])} periods, {len(aei['countries'])} countries, "
          f"{len(subregions)} countries with subregions; {'updated' if changed else 'no changes'}")


if __name__ == "__main__":
    main()
