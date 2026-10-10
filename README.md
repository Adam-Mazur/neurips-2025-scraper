# NeurIPS 2025 OpenReview scraper

Collects every accepted NeurIPS 2025 paper (oral, spotlight, poster) from the
OpenReview API v2, with the title, the authors, and each author's affiliations.

## Setup

```bash
uv sync
cp .env.example .env   # then put your OpenReview login in .env
```

You need an OpenReview account because the API no longer allows anonymous access.

## Usage

```bash
uv run scraper.py scrape --limit 5        # quick test
uv run scraper.py scrape                  # full run; rerun to resume after a crash or Ctrl+C
uv run scraper.py status                  # counts by venue and by author status
uv run scraper.py export --csv data/papers.csv
```

The script saves each paper to `data/papers.jsonl` as soon as it is processed
(one JSON object per line). Author profiles are cached in `data/profiles_cache.jsonl`.
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
