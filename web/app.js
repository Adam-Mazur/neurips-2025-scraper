// UI for the affiliation explorer. Data logic lives in core.js.
import {
  CONTINENTS, POSITION_GROUPS, aggregate, continentOf, buildIndex, parseAliases, rowDetails, searchText,
} from "./core.js?v=2"; // bump ?v= here and in index.html when web/ changes, so browsers refetch

const PAGE = 100;
const TRACKS = ["oral", "spotlight", "poster"];
const DEFAULTS = {
  by: "authors", mode: "alias", byline: "any", continent: "", country: "", q: "", sort: "count-desc",
  tracks: [], groups: [], titles: [],
};

const $ = (id) => document.getElementById(id);
const state = structuredClone(DEFAULTS);
let index = null;
let countries = []; // [code, name, authors], sorted by name
let result = null; // last aggregate()
let shown = PAGE;
const expanded = new Set(); // keys of expanded rows

const countryName = (() => {
  let names;
  try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* old browser */ }
  return (code) => {
    if (!code) return "";
    try { return names?.of(code) || code; } catch { return code; }
  };
})();

const fmtInt = new Intl.NumberFormat("en");
const fmtFrac = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const fmtCount = (n) => (state.by === "fractional" ? fmtFrac.format(n) : fmtInt.format(n));
const fmtPct = (x) => (x >= 0.1 ? `${(x * 100).toFixed(0)}%` : x >= 0.001 ? `${(x * 100).toFixed(1)}%` : "<0.1%");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ------------------------------------------------------------ URL state

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!p.has(k)) { state[k] = structuredClone(v); continue; }
    state[k] = Array.isArray(v) ? p.get(k).split("|").filter(Boolean) : p.get(k);
  }
}

function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const cur = state[k];
    if (Array.isArray(v) ? cur.length : cur !== v) p.set(k, Array.isArray(v) ? cur.join("|") : cur);
  }
  const hash = p.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

// ------------------------------------------------------------ controls

function setupControls() {
  document.querySelectorAll(".segmented").forEach((seg) => {
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state[seg.dataset.name] = btn.dataset.value;
      update();
    });
  });

  // Track chips (paper counts per track)
  const trackCounts = new Map();
  for (const p of index.papers) trackCounts.set(p.track, (trackCounts.get(p.track) || 0) + 1);
  $("track-chips").innerHTML = TRACKS.filter((t) => trackCounts.has(t)).map((t) =>
    `<button type="button" class="chip" data-value="${t}" aria-pressed="false">${t[0].toUpperCase() + t.slice(1)}<span class="n">${fmtInt.format(trackCounts.get(t))}</span></button>`,
  ).join("");
  $("track-chips").addEventListener("click", (e) => toggleIn("tracks", e));

  // Position group chips (distinct authors per group)
  const groupAuthors = countDistinct((s) => s.group);
  $("group-chips").innerHTML = POSITION_GROUPS.filter((g) => groupAuthors.has(g)).map((g) =>
    `<button type="button" class="chip" data-value="${esc(g)}" aria-pressed="false">${esc(g)}<span class="n">${fmtInt.format(groupAuthors.get(g))}</span></button>`,
  ).join("");
  $("group-chips").addEventListener("click", (e) => toggleIn("groups", e));
  $("clear-groups").addEventListener("click", () => { state.groups = []; state.titles = []; update(); });

  // Exact titles
  const titleAuthors = [...countDistinct((s) => s.title)].sort((a, b) => b[1] - a[1]);
  $("title-list").innerHTML = titleAuthors.map(([t, n]) =>
    `<label data-search="${esc(searchText(t))}"><input type="checkbox" value="${esc(t)}"><span class="t">${esc(t)}</span><span class="n">${fmtInt.format(n)}</span></label>`,
  ).join("");
  $("title-list").addEventListener("change", (e) => {
    const t = e.target.value;
    state.titles = e.target.checked ? [...state.titles, t] : state.titles.filter((x) => x !== t);
    update();
  });
  $("title-search").addEventListener("input", (e) => {
    const q = searchText(e.target.value.trim());
    for (const label of $("title-list").children) label.hidden = q && !label.dataset.search.includes(q);
  });

  // Continents and countries (by distinct authors)
  const continentAuthors = countDistinct((s) => s.continent);
  $("continent").insertAdjacentHTML("beforeend", CONTINENTS.filter((c) => continentAuthors.has(c))
    .map((c) => `<option value="${esc(c)}">${esc(c)} (${fmtInt.format(continentAuthors.get(c))})</option>`).join(""));
  $("continent").addEventListener("change", (e) => {
    state.continent = e.target.value;
    update();
  });
  countries = [...countDistinct((s) => s.country)].filter(([c]) => c)
    .map(([c, n]) => [c, countryName(c), n]).sort((a, b) => a[1].localeCompare(b[1]));
  $("country").addEventListener("change", (e) => { state.country = e.target.value; update(); });

  let searchTimer;
  $("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value; update(false); }, 120);
  });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; update(false); });
  document.querySelectorAll(".sort-btn").forEach((btn) => btn.addEventListener("click", () => {
    const field = btn.dataset.sort;
    const [curField, curDir] = state.sort.split("-");
    const dir = field === curField ? (curDir === "asc" ? "desc" : "asc") : field === "count" ? "desc" : "asc";
    state.sort = `${field}-${dir}`;
    update(false);
  }));

  $("reset").addEventListener("click", () => { Object.assign(state, structuredClone(DEFAULTS)); update(); });
  $("more").addEventListener("click", () => { shown += PAGE; render(); });
  $("download").addEventListener("click", downloadCsv);

  $("rows").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const row = e.target.closest(".inst-row");
    if (row) toggleRow(row.dataset.key);
  });
  $("rows").addEventListener("keydown", (e) => {
    const row = e.target.closest(".inst-row");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleRow(row.dataset.key); }
  });

  window.addEventListener("hashchange", () => { readHash(); update(); });
  if (window.matchMedia("(max-width: 900px)").matches) $("filters-box").open = false;
}

function countDistinct(keyFn) {
  const sets = new Map();
  for (const s of index.slots) {
    const k = keyFn(s);
    if (!sets.has(k)) sets.set(k, new Set());
    sets.get(k).add(index.authorKeys[s.author]);
  }
  return new Map([...sets].map(([k, v]) => [k, v.size]));
}

/** Country options, limited to the selected continent. */
function fillCountries() {
  const shown = countries.filter(([c]) => !state.continent || continentOf(c) === state.continent);
  const all = state.continent ? `All of ${state.continent}` : "All countries";
  $("country").innerHTML = `<option value="">${esc(all)}</option>` + shown.map(([c, name, n]) =>
    `<option value="${esc(c)}">${esc(name)} (${fmtInt.format(n)})</option>`).join("");
}

function toggleIn(name, e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const v = chip.dataset.value;
  state[name] = state[name].includes(v) ? state[name].filter((x) => x !== v) : [...state[name], v];
  update();
}

function toggleRow(key) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  render();
}

function syncControls() {
  document.querySelectorAll(".segmented").forEach((seg) => {
    for (const b of seg.children) b.setAttribute("aria-checked", String(b.dataset.value === state[seg.dataset.name]));
  });
  for (const c of $("track-chips").children) c.setAttribute("aria-pressed", String(state.tracks.includes(c.dataset.value)));
  for (const c of $("group-chips").children) c.setAttribute("aria-pressed", String(state.groups.includes(c.dataset.value)));
  for (const input of $("title-list").querySelectorAll("input")) input.checked = state.titles.includes(input.value);
  $("titles-selected").textContent = state.titles.length ? `(${state.titles.length} selected)` : "";
  $("continent").value = state.continent;
  fillCountries();
  $("country").value = state.country;
  if ($("search").value !== state.q) $("search").value = state.q;
  $("sort").value = state.sort;
  const [field, dir] = state.sort.split("-");
  document.querySelectorAll(".sort-btn").forEach((b) => {
    if (b.dataset.sort === field) b.dataset.dir = dir; else delete b.dataset.dir;
  });
  $("count-head").textContent = { authors: "Authors", papers: "Papers", fractional: "Credit" }[state.by];

  const active = state.tracks.length + state.groups.length + state.titles.length +
    (state.continent ? 1 : 0) + (state.country ? 1 : 0) + (state.byline !== "any" ? 1 : 0);
  $("active-count").textContent = active ? `${active} active` : "";
}

// ------------------------------------------------------------ compute & render

function update(recount = true) {
  // A country outside the chosen continent would match nothing; drop it.
  if (state.continent && state.country && continentOf(state.country) !== state.continent) state.country = "";
  if (recount) {
    result = aggregate(index, {
      mode: state.mode, by: state.by, byline: state.byline,
      continent: state.continent, country: state.country,
      tracks: new Set(state.tracks), groups: new Set(state.groups), titles: new Set(state.titles),
    });
    expanded.clear();
  }
  shown = PAGE;
  syncControls();
  writeHash();
  render();
}

function visibleRows() {
  let rows = result.rows;
  const q = searchText(state.q.trim());
  if (q) {
    rows = rows.filter((r) => searchText(r.label).includes(q) ||
      r.slots.some((i) => searchText(index.slots[i].raw).includes(q)));
  }
  const [field, dir] = state.sort.split("-");
  const sign = dir === "asc" ? 1 : -1;
  if (field === "name") {
    rows = [...rows].sort((a, b) => sign * a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
  } else if (dir === "asc") {
    rows = [...rows].sort((a, b) => a.count - b.count || a.label.localeCompare(b.label));
  }
  return rows;
}

function render() {
  const rows = visibleRows();
  const max = result.rows[0]?.count || 1;
  const unit = { authors: "authors", papers: "papers", fractional: "paper credits" }[state.by];

  // Stats
  $("stat-papers").textContent = fmtInt.format(result.papers);
  $("stat-authors").textContent = fmtInt.format(result.authors);
  $("stat-insts").textContent = fmtInt.format(result.rows.length);
  const top = result.rows[0];
  $("stat-top").innerHTML = top
    ? `${esc(top.label)}<span class="muted">${fmtCount(top.count)} ${unit} · ${fmtPct(top.count / result.total)}</span>`
    : "–";
  $("stat-top").title = top ? top.label : "";

  $("summary").textContent = rows.length === result.rows.length
    ? `${fmtInt.format(rows.length)} institutions. Click a row for its aliases, positions and papers.`
    : `${fmtInt.format(rows.length)} of ${fmtInt.format(result.rows.length)} institutions match “${state.q.trim()}”.`;

  if (!rows.length) {
    $("rows").innerHTML = `<tr><td colspan="5" class="empty">No institutions match these filters.</td></tr>`;
    $("more").hidden = true;
    return;
  }

  const html = [];
  for (const r of rows.slice(0, shown)) {
    const open = expanded.has(r.key);
    const spellings = new Set(r.slots.map((i) => index.slots[i].raw)).size;
    const country = topCountry(r);
    html.push(`<tr class="inst-row" data-key="${esc(r.key)}" tabindex="0" aria-expanded="${open}">
      <td class="c-rank">${r.rank}</td>
      <td class="c-name"><span class="inst-name">${esc(r.label)}</span>${spellings > 1 ? `<span class="badge" title="${spellings} different spellings merged">${spellings} names</span>` : ""}
        ${country ? `<span class="inst-meta">${esc(countryName(country))}</span>` : ""}</td>
      <td class="c-count">${fmtCount(r.count)}</td>
      <td class="c-bar"><div class="bar"><span style="width:${(100 * r.count / max).toFixed(2)}%"></span></div></td>
      <td class="c-share">${fmtPct(r.count / result.total)}</td>
    </tr>`);
    if (open) html.push(`<tr class="detail-row"><td colspan="5">${detailHtml(r)}</td></tr>`);
  }
  $("rows").innerHTML = html.join("");
  $("more").hidden = rows.length <= shown;
  $("more").textContent = `Show more (${fmtInt.format(rows.length - shown)} left)`;
}

function topCountry(row) {
  const counts = new Map();
  for (const i of row.slots) {
    const c = index.slots[i].country;
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  let best = "", n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}

function detailHtml(row) {
  const d = rowDetails(index, row);
  const gmax = d.groups[0]?.[1] || 1;
  const papers = d.papers.sort((a, b) => TRACKS.indexOf(a.track) - TRACKS.indexOf(b.track));
  const byline = (orders, n) => orders.map((o) => (o === 0 ? "first" : o === n - 1 ? "last" : null))
    .filter(Boolean).join(" & ");
  return `<div class="detail">
    <div class="panel">
      <h3>Names merged here <span class="muted">· authors</span></h3>
      <ul class="kv">${d.spellings.map(([k, n]) => `<li><span class="k">${esc(k)}</span><span class="n">${fmtInt.format(n)}</span></li>`).join("")}</ul>
    </div>
    <div class="panel">
      <h3>Positions <span class="muted">· authors</span></h3>
      <div class="mini">${d.groups.map(([g, n]) => `<span>${esc(g)}</span><div class="bar"><span style="width:${(100 * n / gmax).toFixed(1)}%"></span></div><span class="n">${fmtInt.format(n)}</span>`).join("")}</div>
      ${d.countries.length > 1 ? `<h3 style="margin-top:12px">Countries</h3><ul class="kv">${d.countries.map(([c, n]) => `<li><span class="k">${esc(countryName(c))}</span><span class="n">${fmtInt.format(n)}</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="panel">
      <h3>Papers <span class="muted">· ${fmtInt.format(papers.length)}</span></h3>
      <ul class="papers">${papers.map((p) => {
        const b = byline(p.orders, p.nAuthors);
        return `<li><span class="track ${esc(p.track)}">${esc(p.track)}</span><a href="https://openreview.net/forum?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${esc(p.title)}</a>${b ? ` <span class="muted">(${b} author)</span>` : ""}</li>`;
      }).join("")}</ul>
    </div>
  </div>`;
}

// ------------------------------------------------------------ CSV

function downloadCsv() {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [["rank", "institution", state.by, "share", "top_country", "names_merged"].join(",")];
  for (const r of visibleRows()) {
    const names = [...new Set(r.slots.map((i) => index.slots[i].raw))].join("; ");
    lines.push([r.rank, r.label, state.by === "fractional" ? r.count.toFixed(3) : r.count,
      (r.count / result.total).toFixed(5), topCountry(r), names].map(cell).join(","));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: `neurips2025-affiliations-by-${state.by}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------ theme & startup

function setupTheme() {
  $("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch { /* storage blocked */ }
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  setupTheme();
  try {
    const [papers, aliases] = await Promise.all([
      fetchText("data/papers.jsonl"),
      fetchText("affiliation_aliases.txt").catch(() => ""),
    ]);
    index = buildIndex(papers, parseAliases(aliases));
  } catch (err) {
    $("rows").innerHTML = `<tr><td colspan="5" class="empty">Could not load the data (${esc(err.message)}).
      If you opened this file directly, serve the folder instead: <code>python -m http.server</code>.</td></tr>`;
    return;
  }
  readHash();
  setupControls();
  update();
}

main();
