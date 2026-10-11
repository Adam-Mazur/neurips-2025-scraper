"""Scrape accepted NeurIPS 2025 papers, their authors and author affiliations from OpenReview.

Usage:
    uv run scraper.py scrape            # run (or resume) the scrape
    uv run scraper.py status            # summary of what has been saved
    uv run scraper.py export --csv out.csv
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata
from collections import Counter
from itertools import zip_longest
from pathlib import Path

import openreview
import requests
from dotenv import load_dotenv

API_URL = "https://api2.openreview.net"
VENUE_ID = "NeurIPS.cc/2025/Conference"
AFFILIATION_YEAR = 2025  # history entries still active in this year count as "current"
MIN_INTERVAL = 0.4  # seconds between API calls (~150/min; the API allows 180/min)
MAX_ATTEMPTS = 6

DATA_DIR = Path("data")
DEFAULT_OUT = DATA_DIR / "papers.jsonl"
DEFAULT_CACHE = DATA_DIR / "profiles_cache.jsonl"
DEFAULT_ALIASES = Path("affiliation_aliases.txt")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- API access


class Api:
    """openreview-py client with throttling, retries and automatic re-login."""

    def __init__(self, username, password):
        self.username = username
        self.password = password
        self.client = openreview.api.OpenReviewClient(
            baseurl=API_URL, username=username, password=password
        )
        self.last_call = 0.0

    def call(self, fn_name, *args, **kwargs):
        for attempt in range(1, MAX_ATTEMPTS + 1):
            wait = MIN_INTERVAL - (time.monotonic() - self.last_call)
            if wait > 0:
                time.sleep(wait)
            self.last_call = time.monotonic()
            try:
                return getattr(self.client, fn_name)(*args, **kwargs)
            except openreview.OpenReviewException as e:
                err = e.args[0] if e.args and isinstance(e.args[0], dict) else {}
                status = err.get("status")
                name = str(err.get("name", ""))
                if status == 401 or "TokenExpired" in name:
                    log("Token expired, logging in again...")
                    self.client.login_user(self.username, self.password)
                    continue
                if status not in (429, 500, 502, 503, 504) or attempt == MAX_ATTEMPTS:
                    raise
                error = e
            except requests.exceptions.RequestException as e:
                if attempt == MAX_ATTEMPTS:
                    raise
                error = e
            delay = min(2**attempt, 120)
            log(f"API error ({error}); retry {attempt}/{MAX_ATTEMPTS - 1} in {delay}s")
            time.sleep(delay)


def connect():
    load_dotenv()
    username = os.getenv("OPENREVIEW_USERNAME")
    password = os.getenv("OPENREVIEW_PASSWORD")
    if not username or not password or username == "you@example.com":
        sys.exit("Set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD in the .env file "
                 "(see .env.example). The OpenReview API no longer allows anonymous access.")
    try:
        return Api(username, password)
    except openreview.OpenReviewException as e:
        sys.exit(f"OpenReview login failed: {e}")


# ------------------------------------------------------------ data handling


def value(content, key, default=None):
    """API v2 note content fields look like {"title": {"value": "..."}}."""
    field = content.get(key)
    return field.get("value", default) if isinstance(field, dict) else default


def as_year(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return None


def pick_affiliations(history):
    """Current history entries; if there are none, the most recent one."""
    entries = [h for h in history or [] if isinstance(h, dict)]
    current = [h for h in entries
               if as_year(h.get("end")) is None or as_year(h.get("end")) >= AFFILIATION_YEAR]
    if not current and entries:
        current = [max(entries, key=lambda h: (as_year(h.get("end")) or 0,
                                               as_year(h.get("start")) or 0))]
    current.sort(key=lambda h: as_year(h.get("start")) or 0, reverse=True)
    result = []
    for h in current:
        inst = h.get("institution") or {}
        result.append({
            "institution": inst.get("name"),
            "domain": inst.get("domain"),
            "country": inst.get("country"),
            "position": h.get("position"),
        })
    return result


def read_jsonl(path):
    """Yield records from a JSONL file, skipping broken lines (e.g. from a crash)."""
    if not path.exists():
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    pass


def repair_tail(path):
    """Cut off a half-written last line so new records start on a clean line."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with open(path, "rb+") as f:
        data = f.read()
        if not data.endswith(b"\n"):
            f.truncate(data.rfind(b"\n") + 1)


class JsonlWriter:
    """Appends one JSON record per line and forces it to disk immediately."""

    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        repair_tail(path)
        self.f = open(path, "a", encoding="utf-8")

    def write(self, record):
        self.f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.f.flush()
        os.fsync(self.f.fileno())

    def close(self):
        self.f.close()


class ProfileCache:
    """Maps a tilde ID to a simplified profile (or None if the API had no profile)."""

    def __init__(self, path):
        self.data = {r["query_id"]: r["profile"] for r in read_jsonl(path)}
        self.writer = JsonlWriter(path)

    def fetch(self, api, ids):
        missing = [i for i in dict.fromkeys(ids) if i not in self.data]
        if missing:
            profiles = api.call("search_profiles", ids=missing)
            found = {}
            for p in profiles:
                simple = {
                    "id": p.id,
                    "affiliations": pick_affiliations(p.content.get("history")),
                }
                # A profile can be requested by any of its names (aliases).
                for name in p.content.get("names", []):
                    if name.get("username"):
                        found[name["username"]] = simple
                found[p.id] = simple
            for i in missing:
                self.data[i] = found.get(i)
                self.writer.write({"query_id": i, "profile": self.data[i]})
        return {i: self.data[i] for i in ids}


def build_record(note, profiles):
    content = note.content
    names = value(content, "authors", []) or []
    ids = value(content, "authorids", []) or []
    authors = []
    for name, aid in zip_longest(names, ids):
        aid = (aid or "").strip()
        if not aid.startswith("~"):
            status, affs = "no_public_profile", []
        elif profiles.get(aid) is None:
            status, affs = "profile_not_found", []
        else:
            affs = profiles[aid]["affiliations"]
            status = "ok" if affs else "no_affiliation_listed"
        authors.append({"name": name, "id": aid or None, "status": status,
                        "affiliations": affs})
    return {
        "id": note.id,
        "title": value(content, "title"),
        "venue": value(content, "venue"),
        "authors": authors,
    }


# ----------------------------------------------------------------- commands


def cmd_scrape(args):
    api = connect()
    done = {r["id"] for r in read_jsonl(args.out) if "id" in r}
    log(f"Already saved: {len(done)} papers. Fetching paper list for {args.venue_id}...")
    notes = api.call("get_all_notes", content={"venueid": args.venue_id})
    todo = [n for n in notes if n.id not in done]
    if args.limit:
        todo = todo[: args.limit]
    log(f"Accepted papers: {len(notes)}. To scrape this run: {len(todo)}.")

    cache = ProfileCache(args.cache)
    writer = JsonlWriter(args.out)
    try:
        for i, note in enumerate(todo, 1):
            ids = [a.strip() for a in value(note.content, "authorids", []) or []
                   if a and a.strip().startswith("~")]
            profiles = cache.fetch(api, ids)
            record = build_record(note, profiles)
            writer.write(record)
            log(f"[{len(done) + i}/{len(notes)}] {record['title']}")
    finally:
        writer.close()
        cache.writer.close()
    log("Done.")


def cmd_status(args):
    venues, statuses = Counter(), Counter()
    papers = 0
    for r in read_jsonl(args.out):
        papers += 1
        venues[r.get("venue")] += 1
        statuses.update(a["status"] for a in r.get("authors", []))
    print(f"Papers saved: {papers}  ({args.out})")
    print("\nBy venue:")
    for v, n in venues.most_common():
        print(f"  {n:6d}  {v}")
    print("\nAuthor status:")
    for s, n in statuses.most_common():
        print(f"  {n:6d}  {s}")


def cmd_export(args):
    columns = ["paper_id", "title", "venue", "author_order", "author_name", "author_id",
               "status", "institutions", "domains", "countries", "positions"]
    rows = 0
    with open(args.csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(columns)
        for r in read_jsonl(args.out):
            for order, a in enumerate(r.get("authors", []), 1):
                affs = a.get("affiliations", [])
                join = lambda key: "; ".join(x.get(key) or "" for x in affs)
                w.writerow([r["id"], r.get("title"), r.get("venue"), order, a.get("name"),
                            a.get("id"), a.get("status"), join("institution"),
                            join("domain"), join("country"), join("position")])
                rows += 1
    print(f"Wrote {rows} author rows to {args.csv}")


def normalize_name_part(name):
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.combining(c)).lower()
    name = name.replace("&", " and ")
    name = re.sub(r"[^\w\s]", " ", name)
    name = " ".join(name.split())
    return name.removeprefix("the ")


def normalize_institution(name):
    """Simple normalization so trivially different spellings count together.

    Comma-separated parts that repeat are kept once, so "Harvard University, Harvard
    University" (a common OpenReview artifact) is the same as "Harvard University".
    """
    parts = (normalize_name_part(p) for p in name.split(","))
    return " ".join(dict.fromkeys(p for p in parts if p))


def load_aliases(path):
    """Read the alias file: a canonical name, followed by indented variant names.

    Returns {normalized variant: canonical name}. Lines starting with # are comments.
    """
    aliases = {}
    if not path.exists():
        return aliases
    canonical = None
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            canonical = line.strip()
            names = [canonical]
        elif canonical is None:
            sys.exit(f"{path}:{lineno}: indented name before any canonical name")
        else:
            names = [line.strip()]
        for name in names:
            key = normalize_institution(name)
            if aliases.get(key, canonical) != canonical:
                sys.exit(f"{path}:{lineno}: '{name}' is already listed under "
                         f"'{aliases[key]}'")
            aliases[key] = canonical
    return aliases


def cmd_top_affiliations(args):
    aliases = {} if args.no_aliases else load_aliases(args.aliases)
    counts = Counter()
    spellings = {}  # normalized name -> Counter of original spellings
    seen = set()
    for r in read_jsonl(args.out):
        for a in r.get("authors", []):
            for aff in a.get("affiliations", []):
                raw = (aff.get("institution") or "").strip()
                key = normalize_institution(raw)
                if not key:
                    continue
                if key in aliases:
                    raw = aliases[key]
                    key = normalize_institution(raw)
                if args.by == "authors":
                    unit = (a.get("id") or a.get("name"), key)
                else:
                    unit = (r["id"], key)
                if unit in seen:
                    continue
                seen.add(unit)
                counts[key] += 1
                spellings.setdefault(key, Counter())[raw] += 1
    if not counts:
        print("No affiliations found. Run 'scrape' first.")
        return
    print(f"Top {args.n} affiliations by number of {args.by} "
          f"({len(counts)} distinct institutions):\n")
    width = len(str(counts.most_common(1)[0][1]))
    for rank, (key, n) in enumerate(counts.most_common(args.n), 1):
        label = spellings[key].most_common(1)[0][0]
        print(f"{rank:4d}. {n:{width}d}  {label}")


EXAMPLES = """examples:
  uv run scraper.py scrape --limit 5              quick test run
  uv run scraper.py scrape                        full run (resumes automatically)
  uv run scraper.py status                        counts by venue / author status
  uv run scraper.py export --csv data/papers.csv  one CSV row per author
  uv run scraper.py top-affiliations -n 30        30 most frequent institutions

run 'uv run scraper.py <command> --help' for the options of a command."""


def main():
    parser = argparse.ArgumentParser(
        description="Scrape accepted NeurIPS 2025 papers from OpenReview.",
        epilog=EXAMPLES, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT,
                        help=f"papers JSONL file (default: {DEFAULT_OUT})")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scrape", help="scrape papers (resumes where it left off)")
    p.add_argument("--limit", type=int, help="only scrape this many new papers (for testing)")
    p.add_argument("--venue-id", default=VENUE_ID, help=f"default: {VENUE_ID}")
    p.add_argument("--cache", type=Path, default=DEFAULT_CACHE,
                   help=f"profile cache file (default: {DEFAULT_CACHE})")
    p.set_defaults(func=cmd_scrape)

    p = sub.add_parser("status", help="summarize the saved data")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("export", help="export saved data to CSV (one row per author)")
    p.add_argument("--csv", type=Path, default=DATA_DIR / "papers.csv")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("top-affiliations", help="list the N most frequent affiliations")
    p.add_argument("-n", type=int, default=20, help="how many to list (default: 20)")
    p.add_argument("--by", choices=["authors", "papers"], default="authors",
                   help="count unique authors per institution, or papers with at least "
                        "one author from it (default: authors)")
    p.add_argument("--aliases", type=Path, default=DEFAULT_ALIASES,
                   help="file of equivalent institution names "
                        f"(default: {DEFAULT_ALIASES})")
    p.add_argument("--no-aliases", action="store_true",
                   help="count names as they are, without the alias file")
    p.set_defaults(func=cmd_top_affiliations)

    args = parser.parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        log("\nInterrupted. Everything scraped so far is saved; run again to resume.")
        sys.exit(130)


if __name__ == "__main__":
    main()
