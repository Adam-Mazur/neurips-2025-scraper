# NeurIPS 2025 affiliations

Collects every accepted NeurIPS 2025 paper (oral, spotlight, poster) from the
OpenReview API v2, with the title, the authors, and each author's affiliations,
and provides a static website to explore which institutions they come from.

```
index.html, web/            the website (plain HTML/CSS/JS, no build step)
data/papers.jsonl           the scraped data (committed; read by the website)
affiliation_aliases.txt     equivalent institution names (used by both)
scraper/                    the Python scraper
```

## Website

The site loads `data/papers.jsonl` and `affiliation_aliases.txt` directly in the
browser and ranks institutions. It lets you:

- count by unique **authors**, by **papers** with at least one author there, or by
  **fractional** credit (each paper gives 1 credit, split equally among its
  authors and then among each author's institutions);
- choose how equivalent names are handled: **as written** (nothing merged),
  **normalized** (case, accents, punctuation, etc.), or **merged** (normalized +
  alias file; matches `top-affiliations`);
- filter by author position (PhD student, professor, ...; or exact job titles),
  author order (first / last), track (oral / spotlight / poster) and country;
- search institutions by any of their aliases, sort by count or name, and open a
  row to see the merged names, position breakdown and the papers;
- download the current table as CSV. The filters are kept in the URL, so links
  to a view can be shared.

Preview locally (browsers block `fetch` from `file://`, so use a server):

```bash
python -m http.server     # from the repo root, then open http://localhost:8000
```

Publish on GitHub Pages: push the repo to GitHub, then in *Settings → Pages*
choose *Deploy from a branch*, branch `master` (or `main`), folder `/ (root)`.
After a new scrape, commit `data/papers.jsonl` and the site updates on push.

## Scraper setup

```bash
cd scraper
uv sync
cp .env.example ../.env   # then put your OpenReview login in .env
```

All scraper commands are run from the `scraper/` directory. They read and write
`data/` and `affiliation_aliases.txt` at the repo root, wherever you run them from.

You need an OpenReview account because the API no longer allows anonymous access.

## Scraper usage

```bash
uv run scraper.py scrape --limit 5        # quick test
uv run scraper.py scrape                  # full run; rerun to resume after a crash or Ctrl+C
uv run scraper.py status                  # counts by venue and by author status
uv run scraper.py export                  # one CSV row per author -> data/papers.csv
uv run scraper.py top-affiliations -n 30          # most frequent institutions (unique authors)
uv run scraper.py top-affiliations --by papers    # ...or papers with >=1 author from there
uv run scraper.py --help                          # all commands; <command> --help for options
```

`top-affiliations` merges names that differ only in case, accents, punctuation,
"&"/"and", a leading "The", or a repeated part ("Kyoto University, Kyoto University").
It then applies `affiliation_aliases.txt`, a hand-made list of equivalent names
(typos, abbreviations, renames, departments of a university, labs of a company):

```
Carnegie Mellon University
    CMU, Carnegie Mellon University
    School of Computer Science, Carnegie Mellon University
```

The first, unindented line is the name that gets printed. Edit the file to change
how institutions are grouped; the header of the file explains the rules used so far.
Use `--no-aliases` to count the raw names, or `--aliases FILE` to use another file.
Names not in the file are shown in their most common spelling.

The scraper saves each paper to `data/papers.jsonl` as soon as it is processed
(one JSON object per line). Author profiles are cached in `data/profiles_cache.jsonl`
(not committed; only `papers.jsonl` is tracked in git).
Requests are spaced to about 150 per minute (the API limit is 180), and failed
requests are retried with backoff.

Author `status` values:

| status                  | meaning                                                 |
|-------------------------|---------------------------------------------------------|
| `ok`                    | public profile with at least one affiliation            |
| `no_affiliation_listed` | public profile, but no career history                   |
| `no_public_profile`     | author is listed by email only (no OpenReview profile)  |
| `profile_not_found`     | profile ID listed, but the API returns no profile       |

Affiliations are the history entries still active in 2025. If there are none,
the most recent entry is used.

Note: Datasets & Benchmarks track papers share the venue ID with the main track.
They are included, and you can tell them apart by the `venue` field.
