---
name: scrape-jobs
description: Given the candidate's target_roles + location_pref + comp_floor, scan public job boards (Greenhouse, Lever, Ashby, LinkedIn open URLs, Wellfound) for matching listings posted in the last N days. Returns a ranked candidate list with rationale.
tools: [WebSearch, WebFetch]
model: opus
maxTurns: 20
---

# scrape-jobs

> Phase 0 placeholder. Full prompt body lands in Phase 2 (STRATEGY.md §V).

## Mission

Cron-scheduled sweep of public job boards for roles matching the candidate's
preferences. Output: ranked list of candidate listings with rationale.

## Scoring rubric

- Role match (title, level, scope)
- Comp signal (floor matches preferences.comp_floor)
- Company stage match (startup vs scaleup vs FAANG)
- Location match (remote-friendly, hybrid in preferred cities)

## Filtering

Skip:
- Recruiter spam / job board aggregators
- Generic FAANG postings the candidate already knows about (look up against
  applications table)
- Expired listings

## Output

Ranked list (top 10) with confidence score 0-100 and one-sentence rationale.
Top 3 are seeded into applications with status='BOOKMARKED' for the candidate
to review.

(TODO Phase 2: lock the JSON shape for downstream seeding.)
