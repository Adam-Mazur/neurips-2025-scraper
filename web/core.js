// Data logic for the affiliation explorer: parsing, name normalization, and
// aggregation. No DOM access, so it can be imported from Node for testing.
// The normalization and alias rules mirror scraper/scraper.py.

// ------------------------------------------------------------ name matching

/** Same as normalize_name_part() in scraper.py. */
export function normalizeNamePart(name) {
  let s = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  s = s.replaceAll("&", " and ");
  s = s.replace(/[^\p{L}\p{N}_\s]/gu, " ");
  s = s.split(/\s+/).filter(Boolean).join(" ");
  return s.startsWith("the ") ? s.slice(4) : s;
}

/** Same as normalize_institution() in scraper.py: repeated comma parts kept once. */
export function normalizeInstitution(name) {
  const parts = name.split(",").map(normalizeNamePart).filter(Boolean);
  return [...new Set(parts)].join(" ");
}

/** Parse affiliation_aliases.txt into a Map {normalized variant: canonical name}. */
export function parseAliases(text) {
  const aliases = new Map();
  let canonical = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    let names;
    if (!/^\s/.test(line)) {
      canonical = line.trim();
      names = [canonical];
    } else if (canonical === null) {
      console.warn(`aliases line ${i + 1}: indented name before any canonical name`);
      return;
    } else {
      names = [line.trim()];
    }
    for (const name of names) {
      const key = normalizeInstitution(name);
      if (aliases.has(key) && aliases.get(key) !== canonical) {
        console.warn(`aliases line ${i + 1}: '${name}' is already listed under '${aliases.get(key)}'`);
        continue;
      }
      aliases.set(key, canonical);
    }
  });
  return aliases;
}

// ------------------------------------------------------------ positions

/** Coarse groups for the hundreds of free-text position titles, in display order. */
export const POSITION_GROUPS = [
  "PhD student", "Master's student", "Undergrad", "Other student", "Intern", "Postdoc",
  "Professor", "Associate professor", "Assistant professor", "Lecturer & other faculty",
  "Researcher / scientist", "Engineer", "Leadership", "Other",
];

const POSITION_RULES = [
  [/\bintern(ship)?\b/i, "Intern"],
  [/post-?doc/i, "Postdoc"],
  [/ph\.?\s?d|doctoral|doctorate/i, "PhD student"],
  [/\bm\.?s\.?c?\b|master|mphil|\bmeng\b/i, "Master's student"],
  [/undergrad|bachelor|\bb\.?sc?\b/i, "Undergrad"],
  [/student/i, "Other student"],
  [/assistant\s+(research\s+)?professor|lecturer \(assistant/i, "Assistant professor"],
  [/associate\s+(research\s+)?professor/i, "Associate professor"],
  [/professor|\bprof\b|emerit/i, "Professor"],
  [/lecturer|instructor|faculty|adjunct|reader|dean/i, "Lecturer & other faculty"],
  [/director|chief|\bvp\b|vice\s+president|president|\bhead\b|\bc[eto]o\b|founder|manager|\blead|leader/i, "Leadership"],
  [/engineer|developer|technical staff|architect/i, "Engineer"],
  [/research|scien|scholar|fellow|investigator/i, "Researcher / scientist"],
];

export function positionGroup(title) {
  if (!title) return "Other";
  for (const [re, group] of POSITION_RULES) if (re.test(title)) return group;
  return "Other";
}

/** Tidy a free-text title so "Research Scientist " and "research scientist" match. */
export function cleanTitle(title) {
  const t = (title || "").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "(none)";
}

// ------------------------------------------------------------ index

export const MODES = ["raw", "norm", "alias"];

/**
 * Turn papers.jsonl text into a flat index of affiliation "slots": one entry per
 * (paper, author, affiliation). Each slot has a group key and a display name for
 * each merging mode (raw / norm / alias).
 */
export function buildIndex(jsonlText, aliases) {
  const papers = [];
  const authorKeys = []; // author id (or name) per author-in-paper
  const slots = [];
  const authorSlotKeys = { raw: [], norm: [], alias: [] }; // distinct keys per author-in-paper
  const normCache = new Map();

  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const paper = papers.length;
    const authors = r.authors || [];
    papers.push({
      id: r.id, title: r.title || "(untitled)",
      track: (r.venue || "").replace(/^NeurIPS 2025\s*/i, "").toLowerCase() || "unknown",
      nAuthors: authors.length,
    });
    authors.forEach((a, order) => {
      const author = authorKeys.length;
      authorKeys.push(a.id || a.name);
      const keysByMode = { raw: new Set(), norm: new Set(), alias: new Set() };
      for (const aff of a.affiliations || []) {
        const raw = (aff.institution || "").trim();
        let norm = normCache.get(raw);
        if (norm === undefined) normCache.set(raw, norm = normalizeInstitution(raw));
        if (!norm) continue;
        const canonical = aliases.get(norm);
        const slot = {
          paper, author, order, last: order === authors.length - 1,
          raw, title: cleanTitle(aff.position), group: positionGroup(aff.position),
          country: (aff.country || "").toUpperCase(),
          key: { raw, norm, alias: canonical ? normalizeInstitution(canonical) : norm },
          display: { raw, norm: raw, alias: canonical || raw },
        };
        slots.push(slot);
        for (const m of MODES) keysByMode[m].add(slot.key[m]);
      }
      for (const m of MODES) authorSlotKeys[m].push(keysByMode[m].size);
    });
  }
  return { papers, authorKeys, slots, authorSlotKeys };
}

// ------------------------------------------------------------ aggregation

/**
 * Count institutions for the slots that pass the filters.
 *
 * opts: { mode: raw|norm|alias, by: authors|papers|fractional,
 *         groups: Set, titles: Set, tracks: Set, byline: any|first|last|firstlast,
 *         country: "" | code }
 * Empty sets mean "no filter".
 *
 * Returns { rows, total, papers, authors }, rows ordered like Python's
 * Counter.most_common() (count desc, then first seen).
 */
export function aggregate(index, opts) {
  const { mode, by } = opts;
  const groups = new Map(); // key -> row
  const seen = new Set();
  const papersSeen = new Set();
  const authorsSeen = new Set();
  let total = 0;

  for (let i = 0; i < index.slots.length; i++) {
    const s = index.slots[i];
    if (!passes(s, index, opts)) continue;
    const key = s.key[mode];
    const authorId = index.authorKeys[s.author];
    papersSeen.add(s.paper);
    authorsSeen.add(authorId);

    let row = groups.get(key);
    if (!row) {
      row = { key, count: 0, labels: new Map(), slots: [] };
      groups.set(key, row);
    }
    row.slots.push(i);

    const unit = by === "papers" ? `${s.paper}\u0000${key}`
      : by === "authors" ? `${authorId}\u0000${key}`
      : `${s.author}\u0000${key}`; // fractional: once per author-in-paper
    if (seen.has(unit)) continue;
    seen.add(unit);

    const credit = by === "fractional"
      ? 1 / index.papers[s.paper].nAuthors / index.authorSlotKeys[mode][s.author]
      : 1;
    row.count += credit;
    const label = s.display[mode];
    row.labels.set(label, (row.labels.get(label) || 0) + 1);
  }

  const rows = [...groups.values()];
  for (const row of rows) row.label = mostCommon(row.labels);
  // Array.sort is stable, so ties keep first-seen order like Counter.most_common().
  rows.sort((a, b) => b.count - a.count);
  rows.forEach((row, i) => { row.rank = i + 1; });

  if (by === "authors") total = authorsSeen.size;
  else if (by === "papers") total = papersSeen.size;
  else total = rows.reduce((sum, r) => sum + r.count, 0);

  return { rows, total, papers: papersSeen.size, authors: authorsSeen.size };
}

function passes(s, index, o) {
  if (o.tracks?.size && !o.tracks.has(index.papers[s.paper].track)) return false;
  if (o.groups?.size && !o.groups.has(s.group)) return false;
  if (o.titles?.size && !o.titles.has(s.title)) return false;
  if (o.country && s.country !== o.country) return false;
  switch (o.byline) {
    case "first": return s.order === 0;
    case "last": return s.last;
    case "firstlast": return s.order === 0 || s.last;
    default: return true;
  }
}

function mostCommon(counter) {
  let best = null, bestN = -1;
  for (const [k, n] of counter) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/** Details for one row: spellings, positions, countries and papers, by distinct author. */
export function rowDetails(index, row) {
  const spellings = new Map(), groups = new Map(), countries = new Map();
  const papers = new Map();
  const authorsBy = (map, k, author) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(author);
  };
  for (const i of row.slots) {
    const s = index.slots[i];
    const author = index.authorKeys[s.author];
    authorsBy(spellings, s.raw, author);
    authorsBy(groups, s.group, author);
    if (s.country) authorsBy(countries, s.country, author);
    if (!papers.has(s.paper)) papers.set(s.paper, new Set());
    papers.get(s.paper).add(s.order);
  }
  const sized = (map) => [...map].map(([k, v]) => [k, v.size]).sort((a, b) => b[1] - a[1]);
  return {
    spellings: sized(spellings),
    groups: sized(groups),
    countries: sized(countries),
    papers: [...papers].map(([p, orders]) => ({ ...index.papers[p], orders: [...orders] })),
  };
}

/** Lowercase, accent-free text for search matching. */
export function searchText(s) {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
