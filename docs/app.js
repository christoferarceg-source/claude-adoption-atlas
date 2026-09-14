"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const approx = v => d3.format(".2~s")(v).replace("G", "B");
const smallPct = v => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0)) + "%";

const f = {
  pct: v => v == null ? "—" : (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)) + "%",
  pct1: v => v == null ? "—" : v.toFixed(1) + "%",
  idx: v => v == null ? "—" : v.toFixed(2),
  mult: v => v == null ? "—" : v.toFixed(2) + "×",
  compact: v => v == null ? "—" : d3.format(".3~s")(v).replace("G", "B"),
  money: v => v == null ? "—" : "$" + d3.format(",")(Math.round(v / 1000)) + "k",
  users: v => v == null ? "—" : `${approx(v * usersRatio())}–${approx(v)}`,
  adopt: v => v == null ? "—" : `${smallPct(v * usersRatio())}–${smallPct(v)}`,
};
const list = arr => arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];

const METRICS = {
  aui: { label: "Intensity (AUI)", fmt: f.idx, kind: "threshold", domain: [0.25, 0.5, 1, 2, 3, 5] },
  share: { label: "Share of global usage", fmt: f.pct, kind: "threshold", domain: [0.1, 0.25, 0.5, 1, 2, 5] },
  users: { label: "Estimated monthly users", fmt: f.users, legendFmt: approx, kind: "threshold", domain: [250e3, 1e6, 2.5e6, 5e6, 10e6, 25e6], estimate: true },
  adoption: { label: "Estimated adoption (% of working-age people)", fmt: f.adopt, legendFmt: smallPct, kind: "threshold", domain: [1, 2.5, 5, 10, 15, 25], estimate: true },
  change: { label: "Change in share since first period", fmt: f.mult, kind: "diverging", domain: [0.5, 0.75, 0.9, 1.1, 1.33, 2] },
  work: { label: "Work use", fmt: f.pct1, kind: "quantile" },
  personal: { label: "Personal use", fmt: f.pct1, kind: "quantile" },
  coursework: { label: "Coursework use", fmt: f.pct1, kind: "quantile" },
  coding: { label: "Coding (software + DevOps)", fmt: f.pct1, kind: "quantile" },
  automation: { label: "Automation-style use", fmt: f.pct1, kind: "quantile" },
};
const SUB_LABELS = { share: "Share of the country's usage", aui: "Intensity (AUI)", change: "Change in share of the country's usage", users: "Estimated monthly users" };

let DATA, SIGNALS, CONTEXT, WORLD, SOURCES, GEO_INDEX = {};
const featuresByIso = new Map();
const subCache = new Map();
const state = { tab: "map", metric: "aui", period: null, region: null, country: null, sub: null, labels: true };
let insightsBuilt = false;

/* ---------- boot ---------- */
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function init() {
  try {
    [DATA, WORLD, SIGNALS, CONTEXT, GEO_INDEX, SOURCES] = await Promise.all([
      getJSON("data/aei.json"),
      getJSON("geo/world.json"),
      getJSON("data/signals.json").catch(() => null),
      getJSON("data/context.json").catch(() => []),
      getJSON("geo/admin1/index.json").catch(() => ({})),
      getJSON("data/sources.json").catch(() => null),
    ]);
  } catch (err) {
    $("#panel").innerHTML = `<p class="error">The atlas data didn't load (${esc(err.message)}). Reload the page to try again.</p>`;
    return;
  }
  state.period = DATA.periods[DATA.periods.length - 1].id;
  readHash();
  buildControls();
  buildMap();
  renderFreshness();
  applyTab();
  render();
  const onNav = () => { readHash(); syncControls(); applyTab(); render(); };
  window.addEventListener("popstate", onNav);
  window.addEventListener("hashchange", onNav);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    render();
    insightsBuilt = false;
    if (state.tab === "insights") buildInsights();
  });
}

function readHash() {
  const [tab, query] = location.hash.slice(1).split("?");
  state.tab = ["map", "insights", "about"].includes(tab) ? tab : "map";
  const q = new URLSearchParams(query || "");
  if (METRICS[q.get("m")]) state.metric = q.get("m");
  if (DATA.periods.some(p => p.id === q.get("p"))) state.period = q.get("p");
  state.region = DATA.regions[q.get("r")] ? q.get("r") : null;
  state.country = DATA.countries[q.get("c")] ? q.get("c") : null;
  state.sub = state.country ? q.get("s") : null;
  state.labels = q.get("l") !== "0";
  if (state.country) state.region = DATA.countries[state.country].region;
}

function writeHash(push) {
  const q = new URLSearchParams({ m: state.metric, p: state.period });
  if (state.region) q.set("r", state.region);
  if (state.country) q.set("c", state.country);
  if (state.sub) q.set("s", state.sub);
  if (!state.labels) q.set("l", "0");
  const hash = `#${state.tab}?${q}`;
  if (hash !== location.hash) history[push ? "pushState" : "replaceState"](null, "", hash);
}

function periodLabel(pid = state.period) {
  return DATA.periods.find(p => p.id === pid)?.label ?? pid;
}

function renderFreshness() {
  const latest = DATA.periods[DATA.periods.length - 1];
  const checked = SIGNALS?.checked_at ? new Date(SIGNALS.checked_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  $("#freshness").textContent = `Latest country data: ${latest.label}${checked ? ` · checked ${checked}` : ""}`;
  if (SOURCES) $("#about-files").textContent = `Files used in this build: ${SOURCES.files.join(", ")}.`;
}

/* ---------- controls & navigation ---------- */
function buildControls() {
  $("#metric").innerHTML = Object.entries(METRICS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join("");
  $("#period").innerHTML = DATA.periods.slice().reverse()
    .map(p => `<option value="${p.id}">${p.label}${p.kind === "one-week sample" ? " (1-week sample)" : ""}</option>`).join("");
  $("#region").innerHTML = `<option value="">World</option>` +
    Object.keys(DATA.regions).filter(r => r !== "Other").sort().map(r => `<option>${esc(r)}</option>`).join("");
  $("#country-list").innerHTML = Object.entries(DATA.countries)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([iso, c]) => `<option value="${esc(c.name)} (${iso})"></option>`).join("");
  syncControls();

  $("#metric").addEventListener("change", e => { state.metric = e.target.value; writeHash(false); render(); });
  $("#period").addEventListener("change", e => { state.period = e.target.value; writeHash(false); render(); });
  $("#region").addEventListener("change", e => navigate({ region: e.target.value || null, country: null, sub: null }));
  $("#search").addEventListener("change", e => {
    const text = e.target.value.trim();
    const code = (text.match(/\(([A-Z]{3})\)$/) || [])[1] || text.toUpperCase();
    const iso = DATA.countries[code] ? code
      : Object.keys(DATA.countries).find(k => DATA.countries[k].name.toLowerCase() === text.toLowerCase());
    if (iso) {
      e.target.value = "";
      navigate({ country: iso, region: DATA.countries[iso].region, sub: null });
    }
  });
  $("#zoom-out").addEventListener("click", zoomOut);
  $("#labels").addEventListener("change", e => { state.labels = e.target.checked; writeHash(false); drawLabels(currentSubInfo); });
  const openFromAdoption = row => {
    const go = row.dataset.go, type = go.slice(0, go.indexOf(":")), key = go.slice(go.indexOf(":") + 1);
    Object.assign(state, { tab: "map", metric: "users" });
    applyTab();
    if (type === "region") navigate({ region: key, country: null, sub: null });
    else navigate({ country: key, region: DATA.countries[key].region, sub: null });
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };
  $("#adoption").addEventListener("click", e => { const row = e.target.closest("[data-go]"); if (row) openFromAdoption(row); });
  $("#adoption").addEventListener("keydown", e => { const row = e.target.closest("[data-go]"); if (row && e.key === "Enter") openFromAdoption(row); });
  document.querySelectorAll("[data-tab]").forEach(btn => btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    writeHash(true);
    applyTab();
  }));
  $("#panel").addEventListener("click", e => {
    const btn = e.target.closest("[data-pick]");
    if (!btn) return;
    const [type, key] = [btn.dataset.pick.slice(0, btn.dataset.pick.indexOf(":")), btn.dataset.pick.slice(btn.dataset.pick.indexOf(":") + 1)];
    if (type === "region") navigate({ region: key, country: null, sub: null });
    if (type === "country") navigate({ country: key, region: DATA.countries[key].region, sub: null });
    if (type === "sub") navigate({ sub: key });
  });
}

function syncControls() {
  $("#metric").value = state.metric;
  $("#period").value = state.period;
  $("#region").value = state.region || "";
  $("#labels").checked = state.labels;
}

function navigate(next) {
  Object.assign(state, next);
  writeHash(true);
  syncControls();
  render();
}

function zoomOut() {
  if (state.sub) navigate({ sub: null });
  else if (state.country) navigate({ country: null, sub: null });
  else if (state.region) navigate({ region: null });
}

function applyTab() {
  document.querySelectorAll("[data-tab]").forEach(btn => btn.setAttribute("aria-selected", String(btn.dataset.tab === state.tab)));
  ["map", "insights", "about"].forEach(t => { $(`#panel-${t}`).hidden = t !== state.tab; });
  if (state.tab === "insights" && !insightsBuilt) buildInsights();
}

/* ---------- values ---------- */
const firstPid = () => DATA.periods[0].id;

// Global monthly-user estimates (lower/upper) that apply from a given period onward.
function userTotals(pid = state.period) {
  return (DATA?.user_totals || []).filter(t => t.from <= pid).sort((a, b) => (a.from < b.from ? 1 : -1))[0] || null;
}

function usersRatio() {
  const t = userTotals(state.period) || (DATA?.user_totals || [])[0];
  return t ? t.low / t.high : 1;
}

function estimateNote() {
  return ` · upper estimate (lower ≈ ${Math.round(1 / usersRatio())}× smaller)`;
}

function cVal(iso, metric = state.metric, pid = state.period) {
  const r = DATA.countries[iso]?.p[pid];
  if (!r) return null;
  if (metric === "users" || metric === "adoption") {
    const t = userTotals(pid), pop = DATA.countries[iso].pop;
    if (!t) return null;
    const users = r.share / 100 * t.high;
    return metric === "users" ? users : pop ? users / pop * 100 : null;
  }
  if (metric === "change") {
    const r0 = DATA.countries[iso].p[firstPid()];
    return pid !== firstPid() && r0 && r0.share >= 0.05 ? r.share / r0.share : null;
  }
  return r[metric] ?? null;
}

function rVal(region, metric = state.metric, pid = state.period) {
  const rp = DATA.regions[region]?.p;
  if (!rp?.[pid]) return null;
  if (metric === "share" || metric === "aui") return rp[pid][metric];
  if (metric === "users" || metric === "adoption") {
    const t = userTotals(pid);
    if (!t) return null;
    const users = rp[pid].share / 100 * t.high;
    return metric === "users" ? users : rp[pid].pop ? users / rp[pid].pop * 100 : null;
  }
  if (metric === "change") return pid !== firstPid() && rp[firstPid()] ? rp[pid].share / rp[firstPid()].share : null;
  return weightedAvg(Object.values(DATA.countries).filter(c => c.region === region), metric, pid);
}

function weightedAvg(countries, metric, pid) {
  let sum = 0, weight = 0;
  countries.forEach(c => {
    const r = c.p[pid];
    if (r && r[metric] != null) { sum += r[metric] * r.share; weight += r.share; }
  });
  return weight ? sum / weight : null;
}

function subMetricFor(iso2) {
  const m = state.metric;
  if (m === "users" || m === "adoption") return "users";
  if (["work", "personal", "coursework", "automation"].includes(m)) return m;
  if (m === "aui" && iso2 === "US") return "aui";
  if (m === "change") return "change";
  return "share";
}

function firstSubPid(sd) {
  return DATA.periods.map(p => p.id).find(id => sd.p[id]);
}

function sVal(sd, code, metric, pid = state.period) {
  const r = sd?.p[pid]?.[code];
  if (!r) return null;
  if (metric === "users") {
    const countryUsers = cVal(state.country, "users", pid);
    return countryUsers == null ? null : countryUsers * r.share / 100;
  }
  if (metric === "change") {
    const base = firstSubPid(sd), r0 = sd.p[base]?.[code];
    return base !== pid && r0 && r0.share >= 1 ? r.share / r0.share : null;
  }
  return r[metric] ?? null;
}

function scaleFor(kind, domain, values) {
  if (kind === "threshold") return d3.scaleThreshold(domain, d3.range(7).map(i => css(`--q${i}`)));
  if (kind === "diverging") return d3.scaleThreshold(domain, d3.range(7).map(i => css(`--d${i}`)));
  const steps = Math.max(1, Math.min(7, new Set(values).size));
  const ramp = d3.range(7).map(i => css(`--q${i}`));
  const colors = steps === 7 ? ramp : d3.range(steps).map(i => ramp[Math.round(i * 6 / Math.max(1, steps - 1))]);
  return d3.scaleQuantile(values.length ? values : [0], colors);
}

function renderLegend(scale, kind, fmt, title) {
  const colors = scale.range();
  const cuts = kind === "quantile" ? scale.quantiles() : scale.domain();
  const items = colors.map((color, i) => {
    const lo = i === 0 ? null : cuts[i - 1], hi = i < cuts.length ? cuts[i] : null;
    const text = lo == null && hi == null ? "All values" : lo == null ? `under ${fmt(hi)}` : hi == null ? `${fmt(lo)}+` : `${fmt(lo)}–${fmt(hi)}`;
    return `<span class="lg-item"><i style="background:${color}"></i>${esc(text)}</span>`;
  });
  $("#legend").innerHTML = `<span class="label">${esc(title)}</span><div class="lg-items">${items.join("")}<span class="lg-item"><i class="nodata"></i>No data</span><span class="lg-item"><i class="hatch"></i>Claude not available</span></div>`;
}

/* ---------- map ---------- */
const MW = 960, MH = 500;
let svg, gRoot, gCountries, gSubs, gLabels, zoom, path, lastZoomKey = null, renderToken = 0;
let currentK = 1, currentSubInfo = null, labelFrame = 0;

function fixWinding(feature) {
  // Natural Earth rings can be wound the "wrong" way for d3's spherical geometry.
  if (feature.geometry && d3.geoArea(feature) > 2 * Math.PI) {
    const g = feature.geometry;
    if (g.type === "Polygon") g.coordinates.forEach(ring => ring.reverse());
    if (g.type === "MultiPolygon") g.coordinates.forEach(poly => poly.forEach(ring => ring.reverse()));
  }
  return feature;
}

function buildMap() {
  svg = d3.select("#map").attr("viewBox", `0 0 ${MW} ${MH}`);
  const projection = d3.geoNaturalEarth1().fitExtent([[6, 6], [MW - 6, MH - 6]], { type: "Sphere" });
  path = d3.geoPath(projection);
  const pattern = svg.append("defs").append("pattern")
    .attr("id", "hatch").attr("patternUnits", "userSpaceOnUse").attr("width", 5).attr("height", 5).attr("patternTransform", "rotate(45)");
  pattern.append("rect").attr("width", 5).attr("height", 5).attr("class", "hatch-bg");
  pattern.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 5).attr("class", "hatch-line");

  gRoot = svg.append("g");
  gRoot.append("path").datum({ type: "Sphere" }).attr("class", "sphere").attr("d", path).on("click", zoomOut);
  gCountries = gRoot.append("g");
  gSubs = gRoot.append("g");
  gLabels = gRoot.append("g").attr("class", "labels");

  const features = topojson.feature(WORLD, WORLD.objects.countries).features.map(fixWinding);
  features.forEach(ft => featuresByIso.set(ft.properties.iso3, ft));
  gCountries.selectAll("path").data(features, d => d.properties.iso3).join("path")
    .attr("class", "country").attr("d", path)
    .on("click", (event, d) => {
      event.stopPropagation();
      const iso = d.properties.iso3;
      if (DATA.countries[iso]) navigate({ country: iso, region: DATA.countries[iso].region, sub: null });
    });

  zoom = d3.zoom().scaleExtent([1, 80]).on("zoom", event => {
    gRoot.attr("transform", event.transform);
    currentK = event.transform.k;
    scheduleLabelLayout();
  });
  svg.call(zoom).on("dblclick.zoom", null);
}

function countryTip(iso, fallbackName) {
  const c = DATA.countries[iso];
  if (DATA.unsupported.includes(iso)) return `<b>${esc(fallbackName)}</b><br>Claude isn't available here`;
  if (!c?.p[state.period]) return `<b>${esc(c?.name || fallbackName)}</b><br>No published data for ${esc(periodLabel())}`;
  const r = c.p[state.period], M = METRICS[state.metric];
  const extra = ["share", "aui", "users"].includes(state.metric) ? "" : `<br>${M.label}: ${M.fmt(cVal(iso))}`;
  const users = cVal(iso, "users");
  return `<b>${esc(c.name)}</b><br>${f.pct(r.share)} of global usage · AUI ${f.idx(r.aui)}${users != null ? `<br>Est. monthly users: ${f.users(users)}` : ""}${extra}`;
}

async function render() {
  if (!DATA) return;
  const token = ++renderToken;
  const M = METRICS[state.metric];
  const values = Object.keys(DATA.countries).map(iso => cVal(iso)).filter(v => v != null);
  const scale = scaleFor(M.kind, M.domain, values);
  const unsupported = new Set(DATA.unsupported);
  const inRegion = iso => DATA.countries[iso]?.region === state.region || DATA.unsupported_regions?.[iso] === state.region;

  gCountries.selectAll("path.country")
    .attr("fill", d => {
      const iso = d.properties.iso3;
      if (unsupported.has(iso)) return "url(#hatch)";
      const v = cVal(iso);
      return v == null ? css("--nodata") : scale(v);
    })
    .classed("dim", d => state.country ? d.properties.iso3 !== state.country : state.region ? !inRegion(d.properties.iso3) : false)
    .classed("active", d => d.properties.iso3 === state.country)
    .attr("data-tip", d => countryTip(d.properties.iso3, d.properties.name));

  if (values.length) renderLegend(scale, M.kind, M.legendFmt || M.fmt, `${M.label} · by country${M.estimate ? estimateNote() : ""}`);
  else $("#legend").innerHTML = `<span class="note">${esc(M.label)} ${M.estimate ? "is only estimated for periods close to when global user totals were measured" : `isn't published for ${esc(periodLabel())}`}. Pick a later period.</span>`;

  let subInfo = null;
  if (state.country) {
    subInfo = await loadSubregions(state.country);
    if (token !== renderToken) return;
  }
  drawSubregions(subInfo);
  currentSubInfo = subInfo;
  drawLabels(subInfo);
  zoomToState();
  renderCrumbs(subInfo);
  renderPanel(subInfo);
  $("#zoom-out").hidden = !state.region;
  $("#map-note").textContent = mapNote(subInfo);
}

async function loadSubregions(iso3) {
  const iso2 = DATA.countries[iso3]?.iso2;
  if (!iso2) return null;
  if (!subCache.has(iso2)) {
    const hasData = DATA.countries_with_subregions.includes(iso2);
    const [data, topo] = await Promise.all([
      hasData ? getJSON(`data/subregions/${iso2}.json`).catch(() => null) : null,
      GEO_INDEX[iso2] ? getJSON(`geo/admin1/${iso2}.json`).catch(() => null) : null,
    ]);
    const features = topo ? topojson.feature(topo, topo.objects.subregions).features.map(fixWinding) : [];
    const names = Object.fromEntries(features.filter(ft => ft.properties.code).map(ft => [ft.properties.code, ft.properties.name]));
    subCache.set(iso2, { iso2, data, features, names });
  }
  return subCache.get(iso2);
}

function subName(info, code) {
  return info?.names?.[code] || code;
}

function drawSubregions(info) {
  gSubs.selectAll("path").remove();
  if (!info?.data || !info.features.length) return;
  const metric = subMetricFor(info.iso2);
  const codes = Object.keys(info.data.p[state.period] || {});
  const values = codes.map(code => sVal(info.data, code, metric)).filter(v => v != null);
  const kind = metric === "change" ? "diverging" : "quantile";
  const scale = scaleFor(kind, METRICS.change.domain, values);
  const fmt = metric === "aui" ? f.idx : metric === "change" ? f.mult : metric === "users" ? f.users : f.pct1;

  gSubs.selectAll("path").data(info.features).join("path")
    .attr("d", path)
    .attr("class", d => `sub${d.properties.code ? "" : " nomatch"}${d.properties.code === state.sub ? " active" : ""}`)
    .attr("fill", d => {
      const v = d.properties.code ? sVal(info.data, d.properties.code, metric) : null;
      return v == null ? css("--nodata") : scale(v);
    })
    .attr("data-tip", d => {
      const code = d.properties.code;
      if (!code) return "No published data for this area";
      const r = info.data.p[state.period]?.[code];
      if (!r) return `<b>${esc(d.properties.name)}</b><br>No published data for ${esc(periodLabel())}`;
      return `<b>${esc(d.properties.name)}</b><br>${f.pct1(r.share)} of ${esc(DATA.countries[state.country].name)}'s usage${r.aui != null ? ` · AUI ${f.idx(r.aui)}` : ""}${metric !== "share" && metric !== "aui" ? `<br>${esc((METRICS[metric] || {}).label || SUB_LABELS[metric])}: ${fmt(sVal(info.data, code, metric))}` : ""}`;
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      if (d.properties.code) navigate({ sub: d.properties.code });
    });

  const title = metric === "change"
    ? `${SUB_LABELS.change} since ${periodLabel(firstSubPid(info.data))}`
    : `${METRICS[metric] && metric !== "share" && metric !== "aui" ? METRICS[metric].label : SUB_LABELS[metric]} · by state/province`;
  if (values.length) renderLegend(scale, kind, metric === "users" ? approx : fmt, title + (metric === "users" ? estimateNote() : ""));
}

/* ---------- user-number labels ---------- */
function labelAnchor(feature) {
  const polys = mainPolygons(feature);
  if (!polys.length) return null;
  const biggest = polys.reduce((a, b) => (path.area(b) > path.area(a) ? b : a));
  const [x, y] = path.centroid(biggest);
  const [[x0, y0], [x1, y1]] = path.bounds(biggest);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y, w: x1 - x0, h: y1 - y0 } : null;
}

function drawLabels(info) {
  gLabels.selectAll("*").remove();
  const note = $("#labels-note");
  if (!state.labels) { note.textContent = ""; return; }
  if (!userTotals()) {
    const first = (DATA.user_totals || []).map(t => t.from).sort()[0];
    const label = DATA.periods.find(p => p.id >= first)?.label;
    note.textContent = label ? `User numbers are only estimated from ${label} onward. Pick a later period to see them.` : "";
    return;
  }
  note.textContent = "Numbers on the map are estimated monthly users (lower–upper range). Zoom in to see smaller places.";
  let items;
  const drilled = state.country && info?.data && info.features.some(ft => ft.properties.code);
  if (drilled) {
    items = info.features.filter(ft => ft.properties.code).map(ft => ({ ft, v: sVal(info.data, ft.properties.code, "users"), force: false }));
  } else {
    items = [...featuresByIso.values()]
      .filter(ft => DATA.countries[ft.properties.iso3] && (!state.country || ft.properties.iso3 === state.country))
      .map(ft => ({ ft, v: cVal(ft.properties.iso3, "users"), force: Boolean(state.country) }));
  }
  items = items.filter(d => d.v != null).map(d => ({ ...d, a: labelAnchor(d.ft), text: f.users(d.v) }))
    .filter(d => d.a).sort((a, b) => b.v - a.v);
  // Inside a country, always label the three biggest places, even small capital districts like Mexico City.
  if (drilled) items.forEach((d, i) => { d.force = i < 3; });
  gLabels.selectAll("text").data(items).join("text")
    .attr("class", "map-label").attr("x", d => d.a.x).attr("y", d => d.a.y)
    .attr("text-anchor", "middle").attr("dominant-baseline", "central")
    .text(d => d.text);
  layoutLabels();
}

function scheduleLabelLayout() {
  if (labelFrame) return;
  labelFrame = requestAnimationFrame(() => { labelFrame = 0; layoutLabels(); });
}

// Show a label only where it fits inside its shape and doesn't collide with a larger place's label.
function layoutLabels() {
  const k = currentK, placed = [];
  gLabels.selectAll("text.map-label").each(function (d) {
    const wPx = d.text.length * 6.4, hPx = 13;
    const w = wPx / k, h = hPx / k;
    const box = { x0: d.a.x - w / 2, x1: d.a.x + w / 2, y0: d.a.y - h / 2, y1: d.a.y + h / 2 };
    const fits = d.force || (d.a.w * k >= wPx * 0.85 && d.a.h * k >= hPx);
    const clear = placed.every(p => box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1);
    const show = fits && clear;
    if (show) placed.push(box);
    this.setAttribute("font-size", (11 / k).toFixed(3));
    this.setAttribute("stroke-width", (3 / k).toFixed(3));
    this.style.display = show ? "" : "none";
  });
}

function mapNote(info) {
  if (!state.country) return "Click a country to see its states or provinces. Drag to pan, scroll to zoom.";
  const name = DATA.countries[state.country].name;
  if (!info?.data) return `Anthropic doesn't publish state or province data for ${name}. City-level data isn't published anywhere.`;
  const g = GEO_INDEX[info.iso2];
  const metric = subMetricFor(info.iso2);
  const swap = metric !== state.metric && state.metric !== "change"
    ? ` ${METRICS[state.metric].label} isn't published below country level here, so the map shows ${SUB_LABELS[metric].toLowerCase()}.` : "";
  if (!g) return `Map shapes aren't available for ${name}'s regions. See the list in the side panel.${swap}`;
  return `${g.matched} of ${g.total} published regions are mapped.${swap} City-level data isn't published.`;
}

function mainPolygons(feature) {
  const g = feature?.geometry;
  if (!g) return [];
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const shapes = polys.map(coords => ({ type: "Polygon", coordinates: coords }));
  const areas = shapes.map(s => path.area(s));
  const max = d3.max(areas) || 0;
  return shapes.filter((s, i) => areas[i] >= max * 0.08);
}

function zoomToState() {
  const key = `${state.region}|${state.country}`;
  if (key === lastZoomKey) return;
  lastZoomKey = key;
  let polys = [];
  if (state.country) polys = mainPolygons(featuresByIso.get(state.country));
  else if (state.region) {
    Object.entries(DATA.countries)
      .filter(([, c]) => c.region === state.region && (c.p[state.period]?.share ?? 0) >= 0.05)
      .forEach(([iso]) => { polys = polys.concat(mainPolygons(featuresByIso.get(iso))); });
  }
  let transform = d3.zoomIdentity;
  if (polys.length) {
    const [[x0, y0], [x1, y1]] = path.bounds({ type: "GeometryCollection", geometries: polys });
    const k = Math.max(1, Math.min(80, 0.86 / Math.max((x1 - x0) / MW, (y1 - y0) / MH)));
    transform = d3.zoomIdentity.translate(MW / 2, MH / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }
  svg.transition().duration(reduceMotion ? 0 : 750).call(zoom.transform, transform);
}

function renderCrumbs(info) {
  const parts = [["world", "World"]];
  if (state.region) parts.push(["region", state.region]);
  if (state.country) parts.push(["country", DATA.countries[state.country].name]);
  if (state.sub) parts.push(["sub", subName(info, state.sub)]);
  $("#crumbs").innerHTML = parts.map(([key, label], i) => i === parts.length - 1
    ? `<span aria-current="page">${esc(label)}</span>`
    : `<button type="button" data-nav="${key}">${esc(label)}</button><span class="sep" aria-hidden="true">›</span>`).join("");
  $("#crumbs").querySelectorAll("[data-nav]").forEach(btn => {
    btn.onclick = () => {
      const n = btn.dataset.nav;
      navigate(n === "world" ? { region: null, country: null, sub: null } : n === "region" ? { country: null, sub: null } : { sub: null });
    };
  });
}

/* ---------- side panel ---------- */
function kpis(items, cls = "") {
  return `<dl class="kpis ${cls}">${items.map(([label, value, sub]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd>${sub ? `<p>${sub}</p>` : ""}</div>`).join("")}</dl>`;
}

function estimateBlock(users, adopt) {
  if (users == null) return "";
  return kpis([["Est. monthly users", f.users(users)], ["Est. adoption", f.adopt(adopt), "of working-age people"]], "k2") +
    `<p class="note">An estimated range, not an account count. <a href="#about">How it's calculated</a></p>`;
}

function sparkline(values, fmt, title) {
  const labels = DATA.periods.map(p => p.label);
  const pts = values.map((v, i) => [i, v]).filter(p => p[1] != null);
  if (pts.length < 2) return "";
  const w = 340, h = 76, bottom = h - 16;
  const x = d3.scaleLinear([0, values.length - 1], [6, w - 52]);
  const y = d3.scaleLinear(d3.extent(pts, p => p[1]), [bottom - 4, 12]).nice();
  const last = pts[pts.length - 1], first = pts[0];
  return `<div><span class="label">${esc(title)}</span>
  <svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}: ${pts.map(p => `${labels[p[0]]} ${fmt(p[1])}`).join(", ")}">
    <path class="spark-area" d="${d3.area().x(p => x(p[0])).y0(bottom).y1(p => y(p[1]))(pts)}"/>
    <path class="spark-line" d="${d3.line().x(p => x(p[0])).y(p => y(p[1]))(pts)}"/>
    <circle class="spark-end" cx="${x(last[0])}" cy="${y(last[1])}" r="4"/>
    ${pts.map(p => `<circle class="spark-hit" cx="${x(p[0])}" cy="${y(p[1])}" r="10" data-tip="${esc(labels[p[0]])}: ${esc(fmt(p[1]))}"/>`).join("")}
    <text class="spark-val" x="${x(last[0]) + 8}" y="${y(last[1]) + 4}">${esc(fmt(last[1]))}</text>
    <text class="spark-lab" x="${x(first[0])}" y="${h - 2}">${esc(labels[first[0]])}</text>
    <text class="spark-lab" x="${x(last[0])}" y="${h - 2}" text-anchor="end">${esc(labels[last[0]])}</text>
  </svg></div>`;
}

function mixBar(r) {
  if (!r || r.work == null) return `<p class="note">The work / personal / coursework split isn't published for this period.</p>`;
  const segs = [["work", "Work", "--s1"], ["personal", "Personal", "--s2"], ["coursework", "Coursework", "--s3"]];
  return `<div class="mix" role="img" aria-label="${segs.map(([k, l]) => `${l} ${f.pct1(r[k])}`).join(", ")}">${segs.map(([k, l, c]) => `<span style="flex:${r[k]};background:var(${c})" data-tip="${l}: ${f.pct1(r[k])}"></span>`).join("")}</div>
  <div class="mix-legend">${segs.map(([k, l, c]) => `<span><i style="background:var(${c})"></i>${l} <b>${f.pct1(r[k])}</b></span>`).join("")}</div>`;
}

function rankList(items, fmt) {
  if (!items.length) return `<p class="note">Nothing published for this view.</p>`;
  const max = d3.max(items, d => Math.abs(d.value ?? 0)) || 1;
  return `<ol class="rank">${items.map((d, i) => `<li><button type="button" ${d.pick ? `data-pick="${esc(d.pick)}"` : "disabled"} ${d.tip ? `data-tip="${esc(d.tip)}"` : ""}>
    <span class="rk">${i + 1}</span>
    <span class="nm">${d.code ? `<span class="code">${esc(d.code)}</span>` : ""}${esc(d.label)}${d.flag ? `<span class="flag">${esc(d.flag)}</span>` : ""}</span>
    <span class="bar"><i style="width:${d.value == null ? 0 : Math.max(1, Math.abs(d.value) / max * 100).toFixed(1)}%"></i></span>
    <span class="v">${fmt(d.value)}</span></button></li>`).join("")}</ol>`;
}

function countryRows(filter) {
  const minShare = ["aui", "change"].includes(state.metric) ? 0.3 : 0.05;
  return Object.entries(DATA.countries)
    .filter(([iso, c]) => filter(iso, c) && (c.p[state.period]?.share ?? 0) >= minShare)
    .map(([iso, c]) => ({ pick: `country:${iso}`, code: iso, label: c.name, value: cVal(iso) }))
    .filter(d => d.value != null)
    .sort((a, b) => b.value - a.value);
}

function renderPanel(info) {
  let html;
  if (state.country && state.sub) html = panelSub(info);
  else if (state.country) html = panelCountry(info);
  else if (state.region) html = panelRegion();
  else html = panelWorld();
  $("#panel").innerHTML = html;
}

function panelWorld() {
  const pid = state.period, M = METRICS[state.metric];
  const rows = Object.entries(DATA.countries).filter(([, c]) => c.p[pid]);
  const topShare = rows.slice().sort((a, b) => b[1].p[pid].share - a[1].p[pid].share)[0];
  const topAui = rows.filter(([, c]) => c.p[pid].share >= 0.3).sort((a, b) => b[1].p[pid].aui - a[1].p[pid].aui)[0];
  const regions = Object.keys(DATA.regions).filter(r => r !== "Other")
    .map(r => ({ pick: `region:${r}`, label: r, value: rVal(r) })).filter(d => d.value != null).sort((a, b) => b.value - a.value);
  const top = countryRows(() => true).slice(0, 15);
  const minNote = ["aui", "change"].includes(state.metric) ? `<p class="note">Only countries with at least 0.3% of global usage are ranked, so tiny samples don't top the list.</p>` : "";
  return `<header class="p-head"><span class="label">World · ${esc(periodLabel())}</span><h2>Global picture</h2></header>
    ${kpis([
      ["Countries", rows.length, "with published data"],
      ["Largest", esc(topShare[0]), `${esc(topShare[1].name)} · ${f.pct(topShare[1].p[pid].share)}`],
      ["Most intensive", esc(topAui[0]), `${esc(topAui[1].name)} · AUI ${f.idx(topAui[1].p[pid].aui)}`],
    ])}
    ${estimateBlock(userTotals()?.high, userTotals() ? userTotals().high / d3.sum(rows, ([, c]) => c.pop || 0) * 100 : null)}
    <h3>Regions by ${esc(M.label.toLowerCase())}</h3>${rankList(regions, M.fmt)}
    <h3>Top countries by ${esc(M.label.toLowerCase())}</h3>${rankList(top, M.fmt)}${minNote}`;
}

function panelRegion() {
  const region = state.region, pid = state.period, M = METRICS[state.metric];
  const r = DATA.regions[region].p[pid];
  const series = k => DATA.periods.map(p => DATA.regions[region].p[p.id]?.[k] ?? null);
  const change = rVal(region, "change");
  const blocked = DATA.unsupported.filter(iso => DATA.unsupported_regions?.[iso] === region);
  const countries = countryRows((iso, c) => c.region === region);
  return `<header class="p-head"><span class="label">Region · ${esc(periodLabel())}</span><h2>${esc(region)}</h2></header>
    ${r ? kpis([
      ["Share of usage", f.pct(r.share)],
      ["AUI", f.idx(r.aui), r.aui >= 1 ? "above population share" : "below population share"],
      ["Since " + periodLabel(firstPid()), f.mult(change), change == null ? "" : change >= 1 ? "share gained" : "share lost"],
    ]) : `<p class="note">No data for this region in ${esc(periodLabel())}.</p>`}
    ${estimateBlock(rVal(region, "users"), rVal(region, "adoption"))}
    ${sparkline(series("share"), f.pct1, "Share of global usage")}
    ${sparkline(series("aui"), f.idx, "Intensity (AUI)")}
    <h3>Countries by ${esc(M.label.toLowerCase())}</h3>${rankList(countries, M.fmt)}
    ${blocked.length ? `<p class="note">Claude isn't available in ${esc(list(blocked.map(iso => featuresByIso.get(iso)?.properties.name || iso)))}.</p>` : ""}`;
}

function panelCountry(info) {
  const iso = state.country, c = DATA.countries[iso], pid = state.period, r = c.p[pid];
  const head = `<header class="p-head"><span class="label">${esc(c.region)} · ${esc(periodLabel())}</span><h2>${esc(c.name)}</h2></header>`;
  if (!r) return head + `<p class="note">No published data for ${esc(c.name)} in ${esc(periodLabel())}. Pick another period.</p>`;
  const all = Object.values(DATA.countries).filter(x => x.p[pid]);
  const rankShare = all.filter(x => x.p[pid].share > r.share).length + 1;
  const big = all.filter(x => x.p[pid].share >= 0.3);
  const rankAui = r.share >= 0.3 ? big.filter(x => x.p[pid].aui > r.aui).length + 1 : null;
  const change = cVal(iso, "change");
  const fit = DATA.summary[pid]?.fit;
  const predicted = fit && c.gdp_pc ? Math.pow(10, fit.intercept + fit.slope * Math.log10(c.gdp_pc)) : null;
  const globalCoding = weightedAvg(Object.values(DATA.countries), "coding", pid);
  const series = k => DATA.periods.map(p => c.p[p.id]?.[k] ?? null);

  const facts = [];
  if (r.coding != null) facts.push(`Coding: <b>${f.pct1(r.coding)}</b> of conversations (global ${f.pct1(globalCoding)})`);
  if (r.automation != null) facts.push(`Automation-style use: <b>${f.pct1(r.automation)}</b>`);
  if (c.gdp_pc) facts.push(`GDP per working-age person: <b>${f.money(c.gdp_pc)}</b>`);
  if (predicted) facts.push(`Uses <b>${f.mult(r.aui / predicted)}</b> what its income predicts (AUI ${f.idx(predicted)} expected)`);

  let subs = "";
  if (info?.data?.p[pid]) {
    const metric = subMetricFor(info.iso2);
    const fmt = metric === "aui" ? f.idx : metric === "change" ? f.mult : metric === "users" ? f.users : f.pct1;
    const items = Object.keys(info.data.p[pid])
      .map(code => ({ pick: `sub:${code}`, code: code.split("-")[1], label: subName(info, code), value: sVal(info.data, code, metric),
        flag: info.names[code] ? "" : "no map shape" }))
      .filter(d => d.value != null).sort((a, b) => b.value - a.value);
    subs = `<h3>States / provinces · ${esc((METRICS[metric] && !["share", "aui"].includes(metric) ? METRICS[metric].label : SUB_LABELS[metric]).toLowerCase())}</h3>${rankList(items, fmt)}`;
  } else if (info?.data) {
    subs = `<p class="note">No state or province data for ${esc(periodLabel())}. Try another period.</p>`;
  } else {
    subs = `<p class="note">Anthropic doesn't publish state or province data for ${esc(c.name)}, usually because samples are below its privacy thresholds.</p>`;
  }

  return head + kpis([
      ["Share of usage", f.pct(r.share), `#${rankShare} of ${all.length}`],
      ["AUI", f.idx(r.aui), rankAui ? `#${rankAui} of ${big.length} larger markets` : "sample too small to rank"],
      ["Since " + periodLabel(firstPid()), f.mult(change), change == null ? "no baseline" : change >= 1 ? "share gained" : "share lost"],
    ]) +
    estimateBlock(cVal(iso, "users"), cVal(iso, "adoption")) +
    sparkline(series("aui"), f.idx, "Intensity (AUI) over time") +
    sparkline(series("share"), f.pct, "Share of global usage over time") +
    `<div><h3 style="margin-bottom:8px">How it's used</h3>${mixBar(r)}</div>` +
    (facts.length ? `<div class="facts-inline">${facts.map(x => `<span>${x}</span>`).join("")}</div>` : "") +
    subs;
}

function panelSub(info) {
  const code = state.sub, c = DATA.countries[state.country], pid = state.period;
  const r = info?.data?.p[pid]?.[code];
  const name = subName(info, code);
  const head = `<header class="p-head"><span class="label">${esc(c.name)} · ${esc(periodLabel())}</span><h2>${esc(name)}</h2></header>`;
  if (!r) return head + `<p class="note">No published data for ${esc(name)} in ${esc(periodLabel())}.</p>`;
  const peers = Object.values(info.data.p[pid]);
  const rank = peers.filter(x => x.share > r.share).length + 1;
  const change = sVal(info.data, code, "change");
  const series = k => DATA.periods.map(p => info.data.p[p.id]?.[code]?.[k] ?? null);
  return head + kpis([
      [`Share of ${c.iso2 || c.name}`, f.pct1(r.share), `#${rank} of ${peers.length}`],
      ["AUI", r.aui != null ? f.idx(r.aui) : "—", r.aui != null ? "vs US average of 1.0" : "published for US states only"],
      ["Since " + periodLabel(firstSubPid(info.data)), f.mult(change), change == null ? "no baseline" : change >= 1 ? "share gained" : "share lost"],
    ]) +
    sparkline(series("share"), f.pct1, `Share of ${c.name}'s usage over time`) +
    (r.aui != null ? sparkline(series("aui"), f.idx, "Intensity (AUI) over time") : "") +
    `<div><h3 style="margin-bottom:8px">How it's used</h3>${mixBar(r)}</div>` +
    (sVal(info.data, code, "users") != null ? `<div class="facts-inline"><span>Est. monthly users: <b>${f.users(sVal(info.data, code, "users"))}</b> (estimated range)</span></div>` : "") +
    `<p class="note">This is the finest geography Anthropic publishes. There's no city-level data.</p>` +
    `<button type="button" class="ghost" data-pick="country:${state.country}">← Back to ${esc(c.name)}</button>`;
}

/* ---------- tooltip ---------- */
const tip = $("#tip");
document.addEventListener("mousemove", e => {
  const target = e.target.closest?.("[data-tip]");
  if (!target) { tip.hidden = true; return; }
  tip.innerHTML = target.getAttribute("data-tip");
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});
document.addEventListener("mouseleave", () => { tip.hidden = true; });

/* ---------- insights ---------- */
function gini(values) {
  const xs = values.slice().sort((a, b) => a - b), n = xs.length, total = d3.sum(xs);
  return total ? d3.sum(xs, (x, i) => (2 * i - n + 1) * x) / (n * total) : 0;
}

function logFit(points) {
  const mx = d3.mean(points, p => p[0]), my = d3.mean(points, p => p[1]);
  const sxx = d3.sum(points, p => (p[0] - mx) ** 2), syy = d3.sum(points, p => (p[1] - my) ** 2);
  const sxy = d3.sum(points, p => (p[0] - mx) * (p[1] - my));
  return { slope: sxy / sxx, r2: (sxy * sxy) / (sxx * syy) };
}

function trendWord(now, before) {
  const ratio = now / before;
  return ratio > 1.05 ? "up from" : ratio < 0.95 ? "down from" : "about level with";
}

function npmSeries(pkg) {
  const s = SIGNALS?.npm?.[pkg];
  if (!s) return null;
  const start = new Date(s.start + "T00:00:00Z");
  const pts = s.downloads.map((v, i) => ({ date: new Date(start.getTime() + i * 86400000), v }));
  pts.forEach((p, i) => {
    const win = pts.slice(Math.max(0, i - 6), i + 1).map(x => x.v).filter(v => v != null);
    p.avg = win.length >= 4 ? d3.mean(win) : null;
  });
  return pts;
}

function windowAvg(series, offset, len) {
  const slice = series.slice(series.length - offset - len, series.length - offset).map(p => p.v).filter(v => v != null);
  return slice.length >= len / 2 ? d3.mean(slice) : null;
}

function buildInsights() {
  insightsBuilt = true;
  const P = DATA.periods, last = P[P.length - 1].id, first = P[0].id, L = periodLabel;
  $("#ins-period").textContent = `${L(first)} → ${L(last)}`;
  const cur = Object.entries(DATA.countries).map(([iso, c]) => ({ iso, ...c })).filter(c => c.p[last]);
  const byShare = cur.slice().sort((a, b) => b.p[last].share - a.p[last].share);
  const big = cur.filter(c => c.p[last].share >= 0.3);
  const byAui = big.slice().sort((a, b) => b.p[last].aui - a.p[last].aui);
  const movers = big.filter(c => c.p[first]?.share >= 0.1).map(c => ({ c, m: c.p[last].share / c.p[first].share })).sort((a, b) => b.m - a.m);
  const regs = Object.entries(DATA.regions).filter(([n, r]) => n !== "Other" && r.p[last] && r.p[first])
    .map(([name, r]) => ({ name, a: r.p[first].share, b: r.p[last].share, d: r.p[last].share - r.p[first].share })).sort((a, b) => b.d - a.d);
  const S0 = DATA.summary[first], S1 = DATA.summary[last];
  const tier = (lo, hi) => cur.filter(c => c.p[last].share >= 0.05 && c.p[last].aui >= lo && c.p[last].aui < hi);
  const low = tier(0, 0.5), high = tier(2.5, Infinity);
  const cards = [];

  const lead = byShare[0], second = byShare[1];
  cards.push({ value: f.pct1(lead.p[last].share), title: `${lead.name} is the largest market`,
    body: `${lead.name} generated ${f.pct1(lead.p[last].share)} of Claude.ai conversations in ${L(last)}${lead.p[first] ? `, ${trendWord(lead.p[last].share, lead.p[first].share)} ${f.pct1(lead.p[first].share)} in ${L(first)}` : ""}. ${second.name} is second at ${f.pct1(second.p[last].share)}, with an AUI of ${f.idx(second.p[last].aui)}.` });

  const t3 = byAui.slice(0, 3);
  cards.push({ value: f.idx(t3[0].p[last].aui), title: `${t3[0].name} uses Claude most intensively`,
    body: `Among countries with at least 0.3% of usage, ${list(t3.map(c => `${c.name} (${f.idx(c.p[last].aui)})`))} lead on use per working-age person. ${lead.name} is at ${f.idx(lead.p[last].aui)}.` });

  if (regs.length > 1) {
    const g = regs[0], l = regs[regs.length - 1];
    cards.push({ value: `${g.d >= 0 ? "+" : ""}${g.d.toFixed(1)} pts`, title: `${g.name} gained the most share`,
      body: `${g.name} went from ${f.pct1(g.a)} to ${f.pct1(g.b)} of global usage between ${L(first)} and ${L(last)}. ${l.name} moved most the other way, from ${f.pct1(l.a)} to ${f.pct1(l.b)}.` });
  }

  if (movers.length >= 6) {
    const up = movers.slice(0, 3), dn = movers.slice(-3).reverse();
    const globalCoding = weightedAvg(cur, "coding", last);
    const downCoding = d3.mean(dn.map(x => x.c.p[last].coding).filter(v => v != null));
    cards.push({ value: f.mult(up[0].m), title: `Fastest growing: ${list(up.map(x => x.c.name))}`,
      body: `Since ${L(first)}, share of global usage grew ${list(up.map(x => `${f.mult(x.m)} in ${x.c.name}`))}.` });
    cards.push({ value: f.mult(dn[0].m), title: `Biggest share losses: ${list(dn.map(x => x.c.name))}`,
      body: `${list(dn.map(x => `${x.c.name} (${f.mult(x.m)})`))} lost the most share.` +
        (globalCoding != null && downCoding != null && downCoding > globalCoding * 1.15
          ? ` These markets lean on coding (${f.pct1(downCoding)} of conversations vs ${f.pct1(globalCoding)} globally), and coding is shifting from chat to Claude Code, which this data doesn't cover. Some of the decline is likely a channel shift.`
          : "") });
  }

  // Compare like with like: only countries published in both periods, so sample coverage changes don't masquerade as trends.
  const common = cur.filter(c => c.p[first] && c.p[first].share >= 0.05 && c.p[last].share >= 0.05);
  if (common.length >= 30) {
    const fitOf = pid => logFit(common.filter(c => c.gdp_pc).map(c => [Math.log10(c.gdp_pc), Math.log10(c.p[pid].aui)]));
    const F0 = fitOf(first), F1 = fitOf(last);
    cards.push({ value: `R² ${F1.r2.toFixed(2)}`, title: "Income explains most of the gap",
      body: `Across the ${common.length} countries published in both periods, GDP per working-age person explains ${Math.round(F1.r2 * 100)}% of the differences in AUI, compared with ${Math.round(F0.r2 * 100)}% in ${L(first)}. A country 1% richer uses about ${F1.slope.toFixed(2)}% more Claude per person.` });
    const g0 = gini(common.map(c => c.p[first].aui)), g1 = gini(common.map(c => c.p[last].aui)), d = g1 - g0;
    cards.push({ value: g1.toFixed(2), title: Math.abs(d) < 0.02 ? "Global concentration isn't falling" : d > 0 ? "Usage is concentrating further" : "Usage is spreading more evenly",
      body: `For those same ${common.length} countries, the Gini coefficient of AUI went from ${g0.toFixed(2)} to ${g1.toFixed(2)}. At 0, every country would use Claude equally per person.` });
  }
  const lc = weightedAvg(low, "coursework", last), hc = weightedAvg(high, "coursework", last);
  const hp = weightedAvg(high, "personal", last), lk = weightedAvg(low, "coding", last);
  if (lc != null && hc != null) {
    cards.push({ value: f.pct1(lc), title: "Early markets start with study and code",
      body: `Where AUI is below 0.5, ${f.pct1(lc)} of conversations are coursework${lk != null ? ` and ${f.pct1(lk)} are coding` : ""}. Where AUI is 2.5 or higher, coursework drops to ${f.pct1(hc)} and personal use leads at ${f.pct1(hp)}.` });
  }
  const npm = npmSeries("@anthropic-ai/claude-code");
  if (npm) {
    const a = windowAvg(npm, 0, 28), b = windowAvg(npm, 28, 28);
    if (a && b) {
      cards.push({ value: `${f.compact(a)}/day`, title: "Claude Code installs, last 28 days",
        body: `npm downloads of Claude Code averaged ${f.compact(a)} a day over the last 28 days, ${a >= b ? "up" : "down"} ${Math.abs((a / b - 1) * 100).toFixed(0)}% on the 28 days before. npm doesn't report by country, so this is a global signal.` });
    }
  }
  $("#insight-cards").innerHTML = cards.map(c => `<article class="ins"><span class="ins-v">${esc(c.value)}</span><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></article>`).join("");

  buildAdoption(last);
  chartRegions();
  chartMovers(movers, L(first), L(last));
  chartIncome(last);
  chartTiers(last);
  chartNpm(npm);
  $("#context-facts").innerHTML = (CONTEXT || []).map(x => `<div class="fact"><span class="v">${esc(x.value)}</span><p>${esc(x.label)}</p><span class="src"><a href="${esc(x.url)}">${esc(x.source)}</a> · ${esc(x.as_of)}</span></div>`).join("");
}

function rangeBar(v, max) {
  const hi = max ? v / max * 100 : 0;
  return `<span class="rbar" aria-hidden="true"><i class="hi" style="width:${hi.toFixed(1)}%"></i><i class="lo" style="width:${(hi * usersRatio()).toFixed(1)}%"></i></span>`;
}

function buildAdoption(pid) {
  const t = userTotals(pid), host = $("#adoption");
  host.hidden = !t;
  if (!t) return;
  const cs = Object.entries(DATA.countries).filter(([, c]) => c.p[pid] && c.pop)
    .map(([iso, c]) => ({ iso, c, share: c.p[pid].share, aui: c.p[pid].aui, users: cVal(iso, "users", pid), adopt: cVal(iso, "adoption", pid) }));
  const regions = Object.keys(DATA.regions).filter(n => n !== "Other" && DATA.regions[n].p[pid]?.pop)
    .map(n => ({ n, share: DATA.regions[n].p[pid].share, users: rVal(n, "users", pid), adopt: rVal(n, "adoption", pid) }))
    .sort((a, b) => b.users - a.users);
  const worldAdopt = t.high / d3.sum(cs, d => d.c.pop) * 100;
  const byUsers = cs.slice().sort((a, b) => b.users - a.users);
  const byAdopt = cs.filter(d => d.share >= 0.3).sort((a, b) => b.adopt - a.adopt);
  const regAdopt = regions.slice().sort((a, b) => b.adopt - a.adopt);
  const lowest = regAdopt[regAdopt.length - 1];
  const headroom = cs.filter(d => d.c.pop >= 50e6 && d.adopt < worldAdopt)
    .map(d => ({ ...d, gap: (worldAdopt - d.adopt) / 100 * d.c.pop })).sort((a, b) => b.gap - a.gap).slice(0, 3);

  $("#adopt-basis").textContent = `${periodLabel(pid)} · based on ${approx(t.low)}–${approx(t.high)} monthly users worldwide`;
  const cards = [
    { value: f.users(regions[0].users), title: `${regions[0].n} has the most users`,
      body: `An estimated ${f.users(regions[0].users)} people in ${regions[0].n} use Claude each month, followed by ${list(regions.slice(1, 3).map(r => `${r.n} (${f.users(r.users)})`))}.` },
    { value: f.adopt(regAdopt[0].adopt), title: `Adoption is deepest in ${regAdopt[0].n}`,
      body: `About ${f.adopt(regAdopt[0].adopt)} of working-age people in ${regAdopt[0].n} use Claude monthly, compared with ${f.adopt(worldAdopt)} across all countries with data. ${lowest.n} is lowest at ${f.adopt(lowest.adopt)}.` },
    { value: f.users(byUsers[0].users), title: "Largest user bases",
      body: `${list(byUsers.slice(0, 5).map(d => `${d.c.name} (${f.users(d.users)})`))}.` },
    { value: f.adopt(byAdopt[0].adopt), title: `Highest adoption: ${list(byAdopt.slice(0, 3).map(d => d.c.name))}`,
      body: `Among countries with at least 0.3% of usage, ${list(byAdopt.slice(0, 3).map(d => `${d.c.name} (${f.adopt(d.adopt)})`))} have the largest share of working-age people using Claude.` },
  ];
  if (headroom.length) {
    cards.push({ value: `+${f.users(headroom[0].gap)}`, title: `Biggest headroom: ${list(headroom.map(d => d.c.name))}`,
      body: `If ${headroom[0].c.name} reached the all-country average adoption of ${f.adopt(worldAdopt)}, it would gain about ${f.users(headroom[0].gap)} monthly users${headroom[1] ? `, and ${headroom[1].c.name} about ${f.users(headroom[1].gap)}` : ""}. These are large working-age populations where adoption is still below average.` });
  }
  $("#adopt-cards").innerHTML = cards.map(c => `<article class="ins"><span class="ins-v">${esc(c.value)}</span><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></article>`).join("");

  const maxR = d3.max(regions, r => r.users);
  $("#adopt-regions").innerHTML = `<thead><tr><th>Region</th><th>Est. monthly users</th><th></th><th class="r">Est. adoption</th><th class="r">Share</th></tr></thead><tbody>` +
    regions.map(r => `<tr data-go="region:${esc(r.n)}" tabindex="0"><td>${esc(r.n)}</td><td>${rangeBar(r.users, maxR)}</td><td class="r">${f.users(r.users)}</td><td class="r">${f.adopt(r.adopt)}</td><td class="r">${f.pct1(r.share)}</td></tr>`).join("") + "</tbody>";
  const top = byUsers.slice(0, 20), maxC = top[0].users;
  $("#adopt-countries").innerHTML = `<thead><tr><th>Country</th><th>Est. monthly users</th><th></th><th class="r">Est. adoption</th><th class="r">AUI</th></tr></thead><tbody>` +
    top.map(d => `<tr data-go="country:${d.iso}" tabindex="0"><td><span class="code">${d.iso}</span> ${esc(d.c.name)}</td><td>${rangeBar(d.users, maxC)}</td><td class="r">${f.users(d.users)}</td><td class="r">${f.adopt(d.adopt)}</td><td class="r">${f.idx(d.aui)}</td></tr>`).join("") + "</tbody>";
  $("#adopt-sources").innerHTML = `Global totals: lower ${esc(approx(t.low))} (<a href="${esc(t.low_url)}">${esc(t.low_source)}</a>), upper ${esc(approx(t.high))} (<a href="${esc(t.high_url)}">${esc(t.high_source)}</a>). Working-age population is for 2024. Click a row to open it on the map.`;
}

function chartRegions() {
  const P = DATA.periods, host = $("#chart-regions");
  host.innerHTML = "";
  const regs = Object.entries(DATA.regions).filter(([n]) => n !== "Other")
    .map(([n, r]) => ({ n, vals: P.map(p => r.p[p.id]?.share ?? null) }))
    .sort((a, b) => (b.vals[b.vals.length - 1] ?? 0) - (a.vals[a.vals.length - 1] ?? 0));
  const ymax = d3.max(regs, r => d3.max(r.vals));
  const w = 250, h = 124, m = { l: 34, r: 46, t: 26, b: 20 };
  regs.forEach(r => {
    const s = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img")
      .attr("aria-label", `${r.n}: share of usage ${r.vals.map(v => f.pct1(v)).join(", ")}`);
    const x = d3.scaleLinear([0, P.length - 1], [m.l, w - m.r]);
    const y = d3.scaleLinear([0, ymax], [h - m.b, m.t]).nice();
    s.append("text").attr("class", "sm-title").attr("x", 0).attr("y", 14).text(r.n);
    y.ticks(3).forEach(t => {
      s.append("line").attr("class", t === 0 ? "axis" : "grid").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(t)).attr("y2", y(t));
      s.append("text").attr("class", "tick").attr("x", m.l - 6).attr("y", y(t) + 4).attr("text-anchor", "end").text(`${t}%`);
    });
    const pts = r.vals.map((v, i) => [i, v]).filter(p => p[1] != null);
    s.append("path").attr("class", "wash").attr("d", d3.area().x(p => x(p[0])).y0(y(0)).y1(p => y(p[1]))(pts));
    s.append("path").attr("class", "line").attr("d", d3.line().x(p => x(p[0])).y(p => y(p[1]))(pts));
    const e = pts[pts.length - 1];
    s.append("circle").attr("class", "end").attr("cx", x(e[0])).attr("cy", y(e[1])).attr("r", 4);
    s.append("text").attr("class", "val").attr("x", x(e[0]) + 7).attr("y", y(e[1]) + 4).text(f.pct1(e[1]));
    s.append("text").attr("class", "tick").attr("x", m.l).attr("y", h - 4).text(P[0].label);
    s.append("text").attr("class", "tick").attr("x", w - m.r).attr("y", h - 4).attr("text-anchor", "end").text(P[P.length - 1].label);
    pts.forEach(p => s.append("circle").attr("class", "hit").attr("cx", x(p[0])).attr("cy", y(p[1])).attr("r", 10)
      .attr("data-tip", `<b>${esc(r.n)}</b><br>${esc(P[p[0]].label)}: ${f.pct1(p[1])} of usage · AUI ${f.idx(DATA.regions[r.n].p[P[p[0]].id]?.aui)}`));
  });
}

function chartMovers(movers, firstLabel, lastLabel) {
  const host = $("#chart-movers");
  host.innerHTML = "";
  $("#movers-sub").textContent = `Share of global usage in ${lastLabel} as a multiple of ${firstLabel}, on a log scale centred on 1× (no change). Countries with at least 0.3% of usage.`;
  if (movers.length < 4) { host.innerHTML = `<p class="note">Not enough overlapping countries to compare yet.</p>`; return; }
  const up = movers.filter(x => x.m >= 1).slice(0, 10), dn = movers.filter(x => x.m < 1).slice(-8);
  const rows = [...up, ...dn], rowH = 24, gap = dn.length && up.length ? 14 : 0;
  const W = 960, m = { l: 180, r: 70, t: 26, b: 8 }, H = m.t + rows.length * rowH + gap + m.b;
  const s = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Change in share of usage by country");
  const lim = 2;
  const x = v => m.l + (Math.max(-lim, Math.min(lim, Math.log2(v))) + lim) / (2 * lim) * (W - m.l - m.r);
  [0.25, 0.5, 1, 2, 4].forEach(t => {
    s.append("line").attr("class", t === 1 ? "axis" : "grid").attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t - 6).attr("y2", H - m.b);
    s.append("text").attr("class", "tick").attr("x", x(t)).attr("y", m.t - 11).attr("text-anchor", "middle").text(`${t === 0.25 ? "¼" : t === 0.5 ? "½" : t}×`);
  });
  let y = m.t;
  rows.forEach((row, i) => {
    if (i === up.length) y += gap;
    const x0 = x(1), x1 = x(row.m), isUp = row.m >= 1, bw = Math.abs(x1 - x0), bh = 14, by = y + (rowH - bh) / 2, rad = Math.min(4, bw);
    const d = isUp
      ? `M${x0},${by}h${bw - rad}a${rad},${rad} 0 0 1 ${rad},${rad}v${bh - 2 * rad}a${rad},${rad} 0 0 1 -${rad},${rad}h-${bw - rad}z`
      : `M${x0},${by}h-${bw - rad}a${rad},${rad} 0 0 0 -${rad},${rad}v${bh - 2 * rad}a${rad},${rad} 0 0 0 ${rad},${rad}h${bw - rad}z`;
    const tipText = `<b>${esc(row.c.name)}</b><br>${f.pct(row.c.p[DATA.periods[0].id].share)} → ${f.pct(row.c.p[DATA.periods[DATA.periods.length - 1].id].share)} of usage (${f.mult(row.m)})`;
    s.append("rect").attr("class", "hit").attr("x", 0).attr("y", y).attr("width", W).attr("height", rowH).attr("data-tip", tipText);
    s.append("path").attr("class", isUp ? "up" : "dn").attr("d", d).attr("pointer-events", "none");
    s.append("text").attr("class", "lab").attr("x", m.l - 12).attr("y", y + rowH / 2 + 4).attr("text-anchor", "end").attr("pointer-events", "none").text(row.c.name);
    s.append("text").attr("class", "val").attr("x", isUp ? x1 + 6 : x1 - 6).attr("y", y + rowH / 2 + 4).attr("text-anchor", isUp ? "start" : "end").attr("pointer-events", "none").text(f.mult(row.m));
    y += rowH;
  });
}

function chartIncome(pid) {
  const host = $("#chart-income");
  host.innerHTML = "";
  const pts = Object.entries(DATA.countries).map(([iso, c]) => ({ iso, c, r: c.p[pid] }))
    .filter(d => d.r && d.c.gdp_pc && d.r.aui > 0 && d.r.share >= 0.05);
  const fit = DATA.summary[pid]?.fit;
  if (pts.length < 5 || !fit) { host.innerHTML = `<p class="note">Not enough data for this period.</p>`; return; }
  $("#income-sub").textContent = `GDP per working-age person against AUI, ${periodLabel(pid)}, log–log. Dot size is share of usage. R² ${fit.r2.toFixed(2)}.`;
  const W = 620, H = 400, m = { l: 48, r: 16, t: 14, b: 44 };
  const s = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Scatter of income against AUI");
  const x = d3.scaleLog([1000, 200000], [m.l, W - m.r]).clamp(true);
  const y = d3.scaleLog([0.05, 10], [H - m.b, m.t]).clamp(true);
  [1000, 3000, 10000, 30000, 100000].forEach(t => {
    s.append("line").attr("class", "grid").attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t).attr("y2", H - m.b);
    s.append("text").attr("class", "tick").attr("x", x(t)).attr("y", H - m.b + 16).attr("text-anchor", "middle").text(`$${t / 1000}k`);
  });
  [0.1, 0.3, 1, 3, 10].forEach(t => {
    s.append("line").attr("class", t === 1 ? "axis" : "grid").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t));
    s.append("text").attr("class", "tick").attr("x", m.l - 8).attr("y", y(t) + 4).attr("text-anchor", "end").text(t);
  });
  s.append("text").attr("class", "tick").attr("x", (m.l + W - m.r) / 2).attr("y", H - 6).attr("text-anchor", "middle").text("GDP per working-age person (log)");
  s.append("text").attr("class", "tick").attr("transform", `translate(12 ${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text("AUI (log)");
  const pred = g => Math.pow(10, fit.intercept + fit.slope * Math.log10(g));
  s.append("line").attr("class", "fit").attr("x1", x(1500)).attr("y1", y(pred(1500))).attr("x2", x(150000)).attr("y2", y(pred(150000)));
  const labelled = new Set(pts.slice().sort((a, b) => b.r.share - a.r.share).slice(0, 10).map(d => d.iso));
  pts.sort((a, b) => b.r.share - a.r.share).forEach(d => {
    const r = Math.max(4, Math.min(12, 2.4 * Math.sqrt(d.r.share) + 3.2));
    s.append("circle").attr("class", `dot${labelled.has(d.iso) ? " hl" : ""}`).attr("cx", x(d.c.gdp_pc)).attr("cy", y(d.r.aui)).attr("r", r)
      .attr("data-tip", `<b>${esc(d.c.name)}</b><br>${f.money(d.c.gdp_pc)} per working-age person<br>AUI ${f.idx(d.r.aui)} (income predicts ${f.idx(pred(d.c.gdp_pc))})<br>${f.pct(d.r.share)} of usage`);
    if (labelled.has(d.iso)) s.append("text").attr("class", "code-lab").attr("x", x(d.c.gdp_pc) + r + 3).attr("y", y(d.r.aui) + 4).text(d.iso);
  });
}

function chartTiers(pid) {
  const host = $("#chart-tiers");
  const tiers = [["Leading", "AUI 2.5+", 2.5, Infinity], ["Upper", "AUI 1–2.5", 1, 2.5], ["Lower", "AUI 0.5–1", 0.5, 1], ["Emerging", "AUI under 0.5", 0, 0.5]];
  const countries = Object.values(DATA.countries).filter(c => c.p[pid] && c.p[pid].share >= 0.05);
  const segs = [["work", "Work", "--s1", "--on-s1"], ["personal", "Personal", "--s2", "--on-s2"], ["coursework", "Coursework", "--s3", "--on-s3"]];
  host.innerHTML = tiers.map(([name, range, lo, hi]) => {
    const group = countries.filter(c => c.p[pid].aui >= lo && c.p[pid].aui < hi);
    const v = Object.fromEntries(segs.map(([k]) => [k, weightedAvg(group, k, pid)]));
    if (v.work == null) return "";
    const total = v.work + v.personal + v.coursework;
    const coding = weightedAvg(group, "coding", pid);
    return `<div class="stk-row"><span>${name}<small>${range} · ${group.length} countries${coding != null ? ` · coding ${f.pct1(coding)}` : ""}</small></span>
      <div class="stk">${segs.map(([k, l, c, on]) => `<span class="seg" style="flex:${(v[k] / total).toFixed(4)};background:var(${c});color:var(${on})" data-tip="<b>${name}</b><br>${l}: ${f.pct1(v[k])}">${v[k] / total > 0.1 ? Math.round(v[k]) + "%" : ""}</span>`).join("")}</div></div>`;
  }).join("") || `<p class="note">The use-case split isn't published for this period.</p>`;
}

function chartNpm(series) {
  const host = $("#chart-npm");
  host.innerHTML = "";
  if (!series?.length) { host.innerHTML = `<p class="note">Download data is unavailable right now.</p>`; return; }
  const W = 960, H = 280, m = { l: 52, r: 20, t: 16, b: 28 };
  const s = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Daily npm downloads of Claude Code");
  const x = d3.scaleUtc(d3.extent(series, d => d.date), [m.l, W - m.r]);
  const y = d3.scaleLinear([0, d3.max(series, d => d.v) || 1], [H - m.b, m.t]).nice();
  y.ticks(4).forEach(t => {
    s.append("line").attr("class", t === 0 ? "axis" : "grid").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t));
    s.append("text").attr("class", "tick").attr("x", m.l - 8).attr("y", y(t) + 4).attr("text-anchor", "end").text(f.compact(t));
  });
  x.ticks(6).forEach(t => s.append("text").attr("class", "tick").attr("x", x(t)).attr("y", H - 8).attr("text-anchor", "middle").text(d3.utcFormat("%b %Y")(t)));
  s.append("path").attr("class", "daily").attr("d", d3.area().defined(d => d.v != null).x(d => x(d.date)).y0(y(0)).y1(d => y(d.v)).curve(d3.curveStep)(series));
  s.append("path").attr("class", "line").attr("d", d3.line().defined(d => d.avg != null).x(d => x(d.date)).y(d => y(d.avg))(series));
  const lastPt = [...series].reverse().find(d => d.avg != null);
  if (lastPt) {
    s.append("circle").attr("class", "end").attr("cx", x(lastPt.date)).attr("cy", y(lastPt.avg)).attr("r", 4);
  }
  const cross = s.append("line").attr("class", "cross").attr("y1", m.t).attr("y2", H - m.b).attr("visibility", "hidden");
  const dot = s.append("circle").attr("class", "end").attr("r", 4).attr("visibility", "hidden");
  const bisect = d3.bisector(d => d.date).center;
  s.append("rect").attr("class", "hit").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b)
    .attr("data-tip", "")
    .on("mousemove", function (event) {
      const [px] = d3.pointer(event, this);
      const d = series[bisect(series, x.invert(px))];
      cross.attr("x1", x(d.date)).attr("x2", x(d.date)).attr("visibility", "visible");
      if (d.avg != null) dot.attr("cx", x(d.date)).attr("cy", y(d.avg)).attr("visibility", "visible");
      this.setAttribute("data-tip", `<b>${d3.utcFormat("%a %d %b %Y")(d.date)}</b><br>Downloads: ${d.v == null ? "not counted by npm" : d3.format(",")(d.v)}<br>7-day average: ${d.avg == null ? "—" : d3.format(",")(Math.round(d.avg))}`);
    })
    .on("mouseleave", () => { cross.attr("visibility", "hidden"); dot.attr("visibility", "hidden"); });
}

init();
