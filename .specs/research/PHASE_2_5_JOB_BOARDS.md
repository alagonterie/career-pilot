# Phase 2.5 — `scrape-jobs` research

**Status:** Research complete, recommendations included. Not yet a spec.
**Date:** 2026-05-27.
**Scope:** Answer the four open questions (Q1 source landscape, Q2 filter input model, Q3 dedup + schema, Q4 surfacing pattern) needed to spec the `scrape-jobs` subagent for Phase 2.5.

> **⚠ Q1 REVERSAL (2026-06-08 — see STRATEGY.md §24.50).** This file recommended ATS-direct (Greenhouse/Lever) as the *primary* source with Google-Jobs/JSearch as Tier B. That is **reversed**: a **Google Jobs API (SerpApi `engine=google_jobs`) is now the primary source**, and ATS-direct demotes to a keyless/quota-free **down-fallback**. Why: the research optimized for breadth + the legal-safety of *self-operated* scraping; the owner's actual objective is *human-equivalent lead quality with zero curation overhead*. ATS-direct is bounded by the hand-curated `ats-targets.json` token list and returns whole boards (sales/GTM noise); Google for Jobs returns the same relevance-ranked, cross-board-deduped postings the candidate finds by hand on LinkedIn/Indeed/company sites. Verified 2026-06-08: SerpApi `google_jobs` is live (free 250/mo, "US Legal Shield"), and OneCLI injects the `api_key` as a query param (`--param-name`) so the container-side call never holds the key. The Q3 schema (`job_leads`, `content_fingerprint`) and Q4 pool-first surfacing are **unaffected** — only Q1's source-mix recommendation is superseded. Full design + the verified live contract live in STRATEGY §24.50.

---

## TL;DR

- **The legal floor under public job scraping is solid in 2026.** The Ninth Circuit's reaffirmation of *hiQ v. LinkedIn* (April 2022) and *Meta v. Bright Data* (Jan 2024, N.D. Cal.) together establish that scraping publicly accessible job postings while logged-out is not a CFAA violation and is not bound by ToS the scraper never accepted. The risks live in *authenticated* scraping, fake accounts, and copyright. We can build on this floor without an account-ban tripwire — provided we never log in and never sign up for accounts on the sites we scrape.
- **The ATS public boards are the goldmine.** Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co/v0/postings`), Ashby (`api.ashbyhq.com/posting-api/job-board`), and Workday (`/wday/cxs/{tenant}/{site}/jobs`) all expose unauthenticated JSON endpoints with stable IDs. Combined, these cover the bulk of well-funded tech employers (~26,500 companies on Greenhouse alone per TheirStack). Greenhouse documents "publicly accessible, cached, not rate limited"; the others are similar in practice with light courtesy delays.
- **HN "Who is Hiring" + workatastartup.com are the highest-quality curated layers.** HN provides the official Firebase API; YC's job board has stable URL patterns and a 5,000+ funded-startup directory.
- **Aggregator APIs are tier-B fillers.** Adzuna and Jooble are free with API-key auth but data is noisy; JSearch (RapidAPI) is the cleanest one-API-many-sources path but costs money at any real volume and bakes LinkedIn/Indeed scraping into someone else's TOS risk. USAJOBS is free and clean for federal roles — useful for breadth even if rarely relevant.
- **LinkedIn is feasible via the `linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` guest endpoint, but it's a hedge, not a primary.** Tier-B with 3-5s pacing. Indeed's public API is dead since 2023; Glassdoor's is dead since 2024. Skip both.
- **Recommendation on Q2 (filter input):** Hybrid (C). Orchestrator passes a short free-text brief (intent + special constraints for this run); `scrape-jobs` reads `candidate_profile` itself via an MCP tool for the structured rules (locations, comp floor, must-have/never-have keywords). This matches how Anthropic's own multi-agent research recipe scopes subagent work, and lets `scrape-jobs` adapt its query strategy without round-trips.
- **Recommendation on Q3 (schema):** Composite natural key `(source, source_job_id)` as the dedup primary key, with a secondary `content_fingerprint` (SimHash over normalized title+company+location+description) for cross-source duplicate detection. Soft-delete via `last_seen_at` + `closed_at` (set on 404/410 from source, or absence-from-feed for N consecutive polls). Never hard-delete — historical funnel data depends on it.
- **Recommendation on Q4 (surfacing):** Pool-first. `scrape-jobs` writes raw + cheap-score (rules-based) on insert; the orchestrator does LLM-scored ranking *at draw time* for the daily briefing, because (a) scoring against a moving target (candidate's evolving brief) shouldn't bake in stale scores at insertion, (b) we already eat the LLM cost on briefing generation. Cadence: every 6 hours on weekdays, daily on weekends. Push-on-match for "killer match" (rules-tier-A + recency<6h) — a small additive layer on top of the pool.

---

## Q1: Source landscape (May 2026)

This section walks the live ecosystem source-by-source. Every tier label is followed by the *why* — the access method, ToS posture, density of senior IC software/AI roles, rate-limit reality, and existing wrapper ecosystem. The tier scheme is **A** (use in v1), **B** (situational / hedge), **C** (avoid or defer to V2).

### ATS public boards

The ATS layer is where senior IC software/AI engineers actually live — these are the systems of record that publish to every aggregator downstream, so going to the source removes a layer of staleness and noise. Of the four, Greenhouse and Lever are unambiguously the densest hunting grounds for the kind of role this project targets.

#### Greenhouse (`boards-api.greenhouse.io`) — Tier **A**

- **Access:** Unauthenticated public JSON. Endpoints:
  - `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs` — list all jobs
  - `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` — include full HTML descriptions
  - `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?pay_transparency=true` — single job with pay ranges, questions, departments, offices ([Greenhouse Job Board API docs](https://developers.greenhouse.io/job-board.html)).
- **ToS / legal:** Greenhouse explicitly designed this API for public consumption ("export information about your public job boards… so your web developers can build custom career and application sites" — [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)). Per [Greenhouse Harvest API rate-limiting docs](https://harvestdocs.greenhouse.io/docs/api-rate-limiting): "The Job Board API is publicly accessible without authentication, cached and not rate limited." No ToS scrape-prohibition for this surface.
- **Quality / density:** 26,500+ companies use Greenhouse per [TheirStack](https://theirstack.com/en/technology/greenhouse); this includes Airbnb, Stripe, Figma, Anthropic, and most of the YC + post-Series-B tech employer set. Greenhouse is "ideal for corporations [with] comprehensive analytics, structured interview formats" per [Index.dev's 2026 ATS comparison](https://www.index.dev/blog/greenhouse-vs-lever-vs-ashby-ats-comparison) — i.e. the senior IC market.
- **Rate / auth model / cost:** None / none / free. Heavily cached at the edge.
- **Wrappers:** Multiple OSS scrapers (e.g., [grnhse/greenhouse-api-docs](https://github.com/grnhse/greenhouse-api-docs)); also wrapped by [Multi-ATS Jobs Scraper on Apify](https://apify.com/alwaysprimedev/multi-ats-jobs-scraper). For our use case we don't need any of these — direct HTTP fetch is fine.
- **Job object stability:** `id` (job post ID), `internal_job_id` (canonical job ID across boards), `title`, `updated_at`, `location.name`, `absolute_url`, `requisition_id`, `metadata[]`, `departments[]`, `offices[]`, plus `content` and `pay_input_ranges` when requested ([Job Board API](https://developers.greenhouse.io/job-board.html)). Stable IDs make dedup trivial.
- **Robots.txt:** `boards.greenhouse.io/robots.txt` only disallows `/embed/`; no crawl-delay (fetched 2026-05-27).
- **Discovery problem:** We need to know `board_token` values to query them. There's no public index. Discovery happens via (a) seed list of curated targets, (b) inference from company careers-page URLs (`https://boards.greenhouse.io/<token>` patterns are publicly visible), (c) third-party indexes like TheirStack which expose token lists. Realistic v1 approach: a curated seed list of ~200 boards we care about (YC companies, public AI labs, post-Series-B startups), grown over time. **This is the load-bearing operational concern for `scrape-jobs`.**

> **Recommendation:** Primary source. Build the `scrape-jobs` flow around Greenhouse first.

#### Lever (`api.lever.co/v0/postings`) — Tier **A**

- **Access:** Unauthenticated public JSON.
  - `GET https://api.lever.co/v0/postings/{site}?mode=json&skip={n}&limit={m}` — list jobs
  - `GET https://api.lever.co/v0/postings/{site}/{posting_id}?mode=json` — single posting
  - EU instance: `https://api.eu.lever.co/v0/postings/`
- **ToS / legal:** Designed for "building job listing sites" — no auth required for read endpoints. Per Lever's [postings-api README](https://github.com/lever/postings-api/blob/master/README.md), the docs explicitly support arbitrary external consumption ("you might want to publish your job postings on your own site"). Rate-limiting is only documented on the POST application endpoint (`429` after >2 req/sec). For reads, `jobs.lever.co/robots.txt` declares `Crawl-delay: 1` for default user agents (fetched 2026-05-27) — we honor that.
- **Quality / density:** Lever's strength is sourcing-heavy teams and CRM-oriented orgs per [Index.dev's 2026 comparison](https://www.index.dev/blog/greenhouse-vs-lever-vs-ashby-ats-comparison). Coverage is "5,000+ Lever-powered career pages" per [Apify Multi-ATS Scraper](https://apify.com/alwaysprimedev/multi-ats-jobs-scraper) — smaller than Greenhouse but with significant non-overlap (lots of mid-stage startups + IC-heavy product orgs).
- **Wrappers:** [lever/postings-api](https://github.com/lever/postings-api) (official docs repo), plus the same Apify/multi-ATS scrapers.
- **Job object:** `id` (stable), `text` (title), `hostedUrl`, `applyUrl`, `categories.{location, commitment, department, level, team, allLocations}`, `createdAt`, `description`, `descriptionPlain`, `lists[]`, `additional`, `salaryRange`, `country` (ISO 3166-1), `workplaceType` (on-site/remote/hybrid). Filter at source via `?location=`, `?team=`, `?department=`, `?commitment=`, `?level=` query params.
- **`workplaceType` is a particular win** — Lever surfaces remote/on-site/hybrid as a first-class field, which Greenhouse hides inside `location.name` strings.

> **Recommendation:** Primary source. Greenhouse + Lever together cover the bulk of the target market.

#### Ashby (`api.ashbyhq.com/posting-api/job-board`) — Tier **A**

- **Access:** Unauthenticated public JSON.
  - `GET https://api.ashbyhq.com/posting-api/job-board/{job_board_name}?includeCompensation=true` ([Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)).
- **ToS / legal:** Public API; no auth; no documented rate limit. Customer-side advanced endpoints exist but are not relevant for our use.
- **Quality / density:** Ashby is "fastest-growing ATS platform in the tech market, winning competitive deals against Greenhouse and Lever" per [Index.dev](https://www.index.dev/blog/greenhouse-vs-lever-vs-ashby-ats-comparison) (4,000+ customers, 100+ migrations from Lever in past year). High signal for newer AI-first startups specifically (Ashby is the de-facto choice for many AI-native cohorts). The 2025 release added `includeCompensation=true` and `job.search` by requisition ID per [Ashby Developer API updates](https://www.ashbyhq.com/product-updates/developer-api-updates).
- **Job object:** `title`, `location`, `secondaryLocations[]`, `department`, `team`, `isRemote` (boolean!), `workplaceType`, `descriptionHtml`, `descriptionPlain`, `publishedAt`, `employmentType`, `address`, `jobUrl`, `applyUrl`, `isListed`, plus `compensation` when requested.
- **Constraint:** No filtering on the public endpoint — you fetch the whole board and filter client-side. For a single board of <500 postings that's fine.

> **Recommendation:** Primary source. Particularly important for AI-native startups — Ashby's customer base skews here.

#### Workday (`/wday/cxs/{tenant}/{site}/jobs`) — Tier **B**

- **Access:** Unauthenticated, but undocumented and POST-based.
  - `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with JSON body `{ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }`
  - `GET https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{externalPath}` — single job detail ([Apify Workday scraper](https://apify.com/orgupdate/workday-job-scraper); [Workday Scraper API](https://jobo.world/ats/workday)).
- **ToS / legal:** Not officially documented but functionally public — no login required, no fake account workaround. Sits in a gray area: it's the same data Google indexes. Per [DEV Community guide](https://dev.to/hasdata_com/building-a-production-ready-job-board-scraper-with-python-pgd), "a small number of Workday tenants return 401/422 errors due to custom security settings." Tenant-by-tenant variance is real.
- **Quality / density:** Workday is the dominant ATS for **enterprise** employers — Salesforce, Workday itself, big banks, F500. Senior IC software roles exist but are diluted by management roles, contractor postings, and the corporate-monolith hiring style. Generally lower role-density per posting for what we want.
- **Operational pain:** Different `wd{N}` data centers per tenant (wd1, wd3, wd5, wd12); tenant discovery requires inspecting actual careers-page URLs. Pagination is offset-based; stop when `jobPostings` array empty OR `offset + limit >= total`.
- **Wrappers:** Multiple Apify actors; OSS examples like [chuchro3/WebCrawler](https://github.com/chuchro3/WebCrawler).

> **Recommendation:** Tier B — defer to v1.1. The role-density per request is lower than Greenhouse/Lever and the tenant-discovery overhead is real. Add it later when targeting specific enterprises (Salesforce, GitHub-via-Microsoft, etc.).

#### Other ATS public boards (SmartRecruiters, Recruitee, Workable) — Tier **C** for v1

- **SmartRecruiters:** Has a [Job Board API](https://developers.smartrecruiters.com/docs/partners-job-board-api) but it requires API Marketplace access ("possible for clients and official SmartRecruiters partners"). Not publicly accessible — skip for personal use.
- **Recruitee:** Has a public "simple API" with no filtering ([fantastic.jobs ATS list](https://fantastic.jobs/article/ats-with-api)); lower-density tech employer base.
- **Workable:** Public job board endpoints exist; smaller share of senior IC software market.

> **Recommendation:** Defer to V2 unless a specific target employer uses one.

### Aggregator APIs

The aggregator layer is "many sources, one auth, one schema" — convenient but lossy. Each one re-publishes ATS data with its own ID space and ranking heuristics. They're useful as **breadth fillers** but never as the sole source for serious lead quality.

#### Adzuna — Tier **B**

- **Access:** REST, `https://api.adzuna.com/v1/api/jobs/{country}/search/{page}` with `app_id` + `app_key` query params ([Adzuna API overview](https://developer.adzuna.com/overview)).
- **Auth:** Free API key on registration.
- **Cost / rate limits:** Adzuna's docs don't specify rate limits publicly; per third-party summaries, the free tier is "generous for most use cases" ([Oreate AI blog](https://www.oreateai.com/blog/navigating-adzunas-api-unpacking-pricing-and-free-tier-possibilities/98fbdb0e1a2ca942a0433e566c6e3ef2)) and Adzuna explicitly invites increased limits for commercial integrations.
- **Quality / density:** Adzuna aggregates UK/US/EU listings. Tech role density is mid (lots of job-board-distributed roles that originate elsewhere; high duplication with sources we already hit).
- **Note on commercial use:** [Adzuna's developer ToS](https://developer.adzuna.com/docs/terms_of_service) restricts redistribution; personal-use querying is fine.

> **Recommendation:** Tier B as a breadth filler. Useful for non-US roles and as a "what are we missing from ATS scraping" diagnostic.

#### Jooble — Tier **B**

- **Access:** REST POST `https://jooble.org/api/{api_key}` with JSON body (keywords, location, salary, etc.) ([Jooble REST API docs](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation)).
- **Auth:** Free API key.
- **Quality:** Global aggregator; high duplication with Indeed/etc. Similar role to Adzuna.

> **Recommendation:** Tier B. Either Adzuna or Jooble suffices; no need for both.

#### JSearch (RapidAPI / OpenWeb Ninja) — Tier **B**

- **Access:** REST via [RapidAPI](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) or direct OpenWeb Ninja portal. Aggregates Google for Jobs (which itself indexes LinkedIn, Indeed, Glassdoor, ZipRecruiter, etc.) ([OpenWeb Ninja JSearch](https://www.openwebninja.com/api/jsearch)).
- **Cost:** "Basic plan has a hard limit of 1,000 requests per hour" per OpenWeb Ninja; tiered pricing at Pro (5 req/sec) and Ultra (10 req/sec).
- **Trade-off:** Lets you piggyback on Google for Jobs results without owning the scraping risk — but the role-quality is "Google for Jobs ranking," which is biased toward popular boards and large employers. Less density at the senior-IC startup tier where Greenhouse/Lever shine.

> **Recommendation:** Tier B. Useful when we want LinkedIn/Indeed/Glassdoor data without owning the scraping operation — but the data quality will be lower than ATS direct.

#### USAJOBS — Tier **B** (free, narrow)

- **Access:** `GET https://data.usajobs.gov/api/Search` with required headers `Host: data.usajobs.gov`, `User-Agent: your_registered_email`, `Authorization-Key: your_key` ([USAJOBS API reference](https://developer.usajobs.gov/api-reference/)).
- **Auth:** Free, immediate-grant API key.
- **Coverage:** Federal positions only (~10,000 live at any time).
- **Use case:** Niche, but free + reliable + structured. Worth including specifically for "civic tech" / federal AI work (e.g., USDS, 18F, IRS modernization). Light volume.

> **Recommendation:** Tier B as a small, high-precision feed. Include in v1.

#### Reed (UK) — Tier **C** for this candidate

- **Access:** REST, [reed.co.uk/developers/Jobseeker](https://www.reed.co.uk/developers/Jobseeker), API key required, free.
- **Rate limit:** 1,000 req/day per third-party docs ([PublicAPI](https://publicapi.dev/reed-api)); recruiter API allows 2,000/hour configurable.
- **Coverage:** UK-only.

> **Recommendation:** Tier C for this candidate (US-focused). Easy to add if scope expands.

#### Findwork.dev — Tier **C**

- **Access:** REST with token auth, 60 req/min cap per [PublicAPI](https://publicapi.dev/findwork-api).
- **Coverage:** Smaller tech-focused board; large overlap with what we already get from ATS direct.

> **Recommendation:** Tier C. Not worth the integration.

### Curated / niche

This is where signal-to-noise gets actually good. These sources are smaller, but every posting is closer to "founder posted this themselves" than "automated repost from an aggregator."

#### Hacker News "Who is Hiring" monthly thread — Tier **A**

- **Access:** Two paths, both unauthenticated:
  - **Firebase API:** [HackerNews/API](https://github.com/HackerNews/API). To find the latest thread: `GET https://hacker-news.firebaseio.com/v0/user/whoishiring.json` returns user record with `submitted` array (story IDs ordered newest-first). Each story → `GET https://hacker-news.firebaseio.com/v0/item/{id}.json` returns `{by, descendants, id, kids, score, text, time, title, type, url}`. The `kids` array contains comment IDs — each must be fetched separately.
  - **Algolia API (faster):** `GET https://hn.algolia.com/api/v1/items/{story_id}` returns the entire thread tree in one request (no recursive fetching). No API key required.
- **ToS / legal:** Public API, no rate limits documented, designed for third-party consumption.
- **Quality / density:** *Exceptional* for our target. ~400-900 top-level job postings per month, with a 2026-current concentration of staff/principal-level remote roles, AI/ML positions, and YC-style startups. Format conventions are stable enough for reliable LLM parsing:
  - `Company | Role | Location | Remote status | Compensation (optional) | Apply link` (verified against [Dec 2025 thread](https://news.ycombinator.com/item?id=46108941) — most comments follow this pattern with minor variations).
  - Location tags use standardized markers: `REMOTE`, `REMOTE (US)`, `REMOTE (EU)`, `ONSITE`, `HYBRID`.
- **Volume:** Manageable. One LLM-parse pass over ~500 comments at thread-publish time (first business day of each month, 11am Eastern) gives a fresh month-of-leads in one batch.
- **Wrapper precedent:** [HNHIRING.com](https://hnhiring.com) indexes 59,210+ jobs back to 2018; [safinahmed/hnhiring](https://github.com/safinahmed/hnhiring) and [brmeyer/hacker-news-who-is-hiring-parser](https://github.com/brmeyer/hacker-news-who-is-hiring-parser) are OSS parsers we can reference. None of them solve our actual problem (LLM scoring against this specific candidate's profile) but the parser pattern is well-trodden.

> **Recommendation:** Primary source. Run a monthly batch right after the thread publishes; this single feed will likely produce more "perfect fit" senior IC AI/ML leads than any other.

#### Y Combinator Work at a Startup — Tier **A**

- **Access:** Public HTML (no API documented), but the page structure exposes:
  - `https://www.workatastartup.com/companies` (1,000+ vetted YC companies)
  - `https://www.workatastartup.com/jobs` (filterable job listings)
  - `https://api.ycombinator.com/v0.1/companies` (undocumented but publicly-callable company metadata endpoint)
- **ToS / legal:** No login required for the data we want. No documented rate limits.
- **Quality / density:** Per [YC search results](https://www.workatastartup.com/), 1,000+ "vetted, funded YC startups" with active hiring. Concentrated in early-stage; comp varies wildly but high equity upside.
- **Wrapper precedent:** Multiple Apify actors ([scrapepilot YC scraper](https://apify.com/scrapepilot/yc-startup-jobs-scraper----companies-jobs-founders), [Nneji123/ycombinator-scraper](https://github.com/Nneji123/ycombinator-scraper)); covers 5,700+ funded startups W05–current.

> **Recommendation:** Primary source. The YC ecosystem is over-indexed for the candidate's "AI engineer in a real product startup" profile.

#### Welcome to the Jungle (formerly Otta) — Tier **B**

- **Access:** No public API; scraping via Apify actors ([welcometothejungle-jobs-scraper](https://apify.com/orgupdate/welcometothejungle-jobs-scraper)) — but Wellfound-style anti-bot defenses are likely active (post-Otta-acquisition the platform [merged into Welcome to the Jungle in Jan 2024](https://tech.eu/2024/01/22/welcome-to-the-jungle-acquires-job-search-platform-otta/)).
- **Quality / density:** Strong curation for senior product/eng roles. 7,000+ vetted companies.
- **Risk:** ToS likely prohibits scraping; would require accepting the same risk class as LinkedIn (without the precedent backing). Not worth it when ATS direct already covers most of the same employers.

> **Recommendation:** Tier B / defer. The same companies almost always post to Greenhouse/Lever; we're not missing much by skipping WTTJ.

#### Wellfound (formerly AngelList) — Tier **C**

- **Access:** Public site with GraphQL backend, but [Scrapfly](https://scrapfly.io/blog/posts/how-to-scrape-wellfound-aka-angellist) reports active anti-scraping (DataDome + Cloudflare, ML bot detection, residential proxies required). [subbuwu/wellfound_graphqlscout](https://github.com/subbuwu/wellfound_graphqlscout) reverse-engineered the GraphQL endpoint but the maintenance burden is high.
- **Quality:** Reasonable startup density, but heavy overlap with YC + Greenhouse.

> **Recommendation:** Tier C. Effort/reward unfavorable; YC + ATS direct gets us 90% of the same companies.

#### Levels.fyi (jobs surface) — Tier **C** for `scrape-jobs`

- **Access:** [Official API exists](https://www.levels.fyi/api-access/) but is primarily a *compensation* product, not job search.
- **Use case:** Belongs in the `tailor-resume` / comp-research flow (Phase 3+), not `scrape-jobs`.

> **Recommendation:** Defer to comp-research subagent flow.

#### RemoteOK — Tier **B**

- **Access:** Public JSON at `https://remoteok.com/api` ([RemoteOK API page](https://remoteok.com/api)); fields include `id`, `slug`, `position`, `company`, `location`, `tags`, `description` (HTML), `date`, `url`, `apply_url`, `salary_min`/`salary_max`, `company_logo`. 50,000+ listings claimed.
- **ToS:** Explicit attribution requirement: "Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source." Non-compliance can revoke API access. For a personal-use candidate dashboard this is satisfied by storing the source URL and surfacing "RemoteOK" as a source label.
- **Rate limit:** Not specified.

> **Recommendation:** Tier B. Useful breadth for remote roles; respect attribution. Light integration cost.

#### Remotive — Tier **B**

- **Access:** `https://remotive.com/api/remote-jobs` ([Remotive API](https://remotive.com/api/remote-jobs)); returns JSON with `id`, `url`, `title`, `company_name`, `category`, `tags[]`, `job_type`, `publication_date`, `candidate_required_location`, `salary`, `description`.
- **ToS:** Strict — only fetch "couple of times a day (we advise max. 4 times a day)"; data is delayed by 24h; "do not submit Remotive listings to third-party job boards (Jooble, Neuvoo, Google Jobs, LinkedIn)"; attribution required.
- **Quality:** Curated remote tech roles, modest volume.

> **Recommendation:** Tier B with strict polling cadence (4×/day max). Easy to add.

#### We Work Remotely — Tier **C**

- **Access:** Public RSS at `https://weworkremotely.com/categories/remote-programming-jobs.rss` (no JSON API). Limited fields per posting.

> **Recommendation:** Tier C. Lower-density than RemoteOK; not worth a separate integration.

#### AI-niche boards (aijobs.com, Karkidi, ai-jobs.net) — Tier **B**

- **Access:** [aijobs.com](https://aijobs.com/) and similar publish JSON-LD `JobPosting` structured data per posting (HTML scrape + JSON-LD extract); no documented API.
- **Quality:** Hyper-focused on the candidate's exact specialization. Density is high per-posting but volume is modest.
- **Wrapper:** No major OSS scraper; would build our own JSON-LD extractor.

> **Recommendation:** Tier B. Build a generic "JSON-LD `JobPosting`" extractor (see direct-careers-pages section below) and point it at this list of niche boards.

### LinkedIn (what's actually possible)

LinkedIn is the single largest job-posting surface for senior tech roles. The honest 2026 answer for our project:

- **What's legal:** Scraping *logged-out* public job postings. Per [hiQ v. LinkedIn (9th Cir. 2022)](https://law.justia.com/cases/federal/appellate-courts/ca9/17-16783/17-16783-2022-04-18.html), the CFAA does not criminalize automated collection of publicly accessible data. Per the [Apify legal-analysis summary](https://blog.apify.com/hiq-v-linkedin/), the surviving concerns are (a) contract claims if a user-agreement was accepted, (b) fake-account creation. As long as we never sign in, we never accept LinkedIn's user agreement, and the *Meta v. Bright Data* (N.D. Cal. Jan 2024) ruling further confirms that ToS does not bind a non-user — Judge Edward Chen wrote: "Meta's terms are only applicable to a user who is actively logged into their account" ([Bright Data press release](https://www.prnewswire.com/news-releases/court-rules-in-favor-of-bright-data-in-meta-v-bright-data-case-reaffirming-the-right-to-collect-public-web-data-302043730.html); [TechCrunch coverage Jan 2024](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued/)).
- **What's not legal:** Logged-in scraping, fake accounts, scraping behind any auth gate. We will not do any of these.
- **What's *banned by LinkedIn's automated systems* if you push it:** Even logged-out, aggressive scraping trips abuse detection and returns CAPTCHA or 999 responses. The technical risk is "your IP gets shadowbanned for 24h," not legal liability.

The actual viable surface in 2026:

- **`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`** — undocumented public guest endpoint returning HTML job-card listings. Query params include `keywords`, `location`, `geoId`, `f_TPR` (time posted), `f_E` (experience level), `f_WT` (remote/onsite), `start` (pagination offset, 25 per page). Confirmed accessible without login per [DEV Community Aug 2026 guide](https://dev.to/agenthustler/how-to-scrape-linkedin-job-listings-in-2026-public-data-without-login-5094) and [Apify LinkedIn Jobs Scraper actor](https://apify.com/cryptosignals/linkedin-jobs-scraper).
- **Rate limit reality:** Anecdotal "3-5 seconds between requests" advice from [iProyal guide](https://iproyal.com/blog/web-scraping-linkedin/). Aggressive pacing trips IP-level blocks.
- **Pagination:** LinkedIn returns at most ~1,000 results per query regardless of total matches; depth >25 pages is unreliable. **Implication:** must use narrow queries.

> **Recommendation:** Tier B with discipline. Add behind a feature-flag in `scrape-jobs`. Pacing 5s+ between calls, max ~100 postings per query, narrow keyword/location queries. Honor LinkedIn's signal — back off on 429/999/CAPTCHA. **Never** create a LinkedIn account for the scraper to use; that move would shift the legal posture from "Tier B with court-precedent backing" to "Tier C with hiQ-style breach-of-contract exposure."

### Indeed / Glassdoor (the 2026 story)

- **Indeed Publisher API:** Deprecated. Indeed's [Apify Indeed API actor](https://apify.com/api/indeed-api) and [JobsPikr](https://www.jobspikr.com/blog/indeed-api-unleashing-the-power-of-real-time-job-data-integration/) confirm the previously-public Get Job and Job Search publisher API has been retired (2020-2023 phaseout). No replacement for personal-use developers.
- **Glassdoor API:** Public dev API shut down. Per [DEV Community 2026 retrospective](https://dev.to/agenthustler/glassdoor-api-in-2026-why-developers-are-switching-to-web-scraping-na0), "In 2024, Glassdoor (now owned by Recruit Holdings alongside Indeed) restricted API access to enterprise partners only… no public documentation, no free tier, no developer signup page."
- **Scraping path:** Both are scrapable in principle but anti-bot defenses (Datadome on Glassdoor, CAPTCHAs on Indeed) make it operationally painful. [JobSpy](https://github.com/speedyapply/JobSpy) (Python library, multi-source) wraps them but acknowledges fragility.

> **Recommendation:** Tier C. Indeed and Glassdoor jobs largely re-appear in JSearch (via Google for Jobs) and on aggregators. Don't build direct integrations; use JSearch (Tier B) to backfill if needed.

### Direct careers pages (when ATS doesn't cover)

For employers who run their own careers page (not on Greenhouse/Lever/Ashby/Workday/etc.), we can extract structured job data via the `schema.org/JobPosting` JSON-LD convention.

- **Coverage:** Google requires this structured data for "Google for Jobs" indexing inclusion, so any company that wants Google Jobs visibility ships it. Per [Google Search Central JobPosting docs](https://developers.google.com/search/docs/appearance/structured-data/job-posting), the required fields are `title`, `description`, `datePosted`, `validThrough`, `employmentType`, `hiringOrganization.name`, `jobLocation`, `baseSalary`. Optional but commonly present: `applicantLocationRequirements`, `jobLocationType` (`TELECOMMUTE`), `directApply`.
- **Extraction strategy:** `GET careers_page_url → parse HTML → extract <script type="application/ld+json"> blocks → filter where @type == "JobPosting"`. Reliable across most modern careers pages.
- **Fallback:** If no JSON-LD, fall back to HTML sitemap parsing (`/sitemap.xml` often has a `/careers/jobs/*` section) + per-page HTML parsing. Lower precision.
- **Sitemap convention:** Many ATSes publish `/sitemap_jobs.xml` or similar. Detectable per host.
- **Risk:** Each direct careers page is a unique scrape target. Sustained maintenance overhead is real.

> **Recommendation:** Tier B as a **generic JSON-LD extractor** rather than per-employer integrations. Apply it to (a) niche AI job boards (aijobs.com etc.), (b) curated targets not on a major ATS. Defer per-employer custom scrapers to v1.1+.

### The ATS-board-discovery problem (a load-bearing operational concern)

Greenhouse, Lever, and Ashby all have the same operational gap: the JSON API requires a `board_token` / `site` / `job_board_name` identifier, but there is no public *index* of valid tokens. Solving this is a precondition for `scrape-jobs` to be useful, and it's worth being explicit about the options:

1. **Curated seed list (recommended for v1).** Maintain `groups/career-pilot/data/ats-targets.json` with ~200 entries:
   ```json
   [
     {"company": "Anthropic", "ats": "greenhouse", "token": "anthropic", "priority": "A"},
     {"company": "Stripe", "ats": "greenhouse", "token": "stripe", "priority": "A"},
     {"company": "Replicate", "ats": "ashby", "token": "replicate", "priority": "A"},
     ...
   ]
   ```
   The list is human-curated, version-controlled, grows over time. **This is the right v1 answer.** It encodes the candidate's actual target list and makes "is X hiring?" trivially queryable. ~200 entries covers most of the YC + post-Series-B + AI-native cohort.

2. **Crawl `boards.greenhouse.io/{token}` 404-vs-200.** Brute-force token enumeration is technically possible (Greenhouse returns 200 if the board exists, 404 otherwise) but is (a) noisy traffic and (b) doesn't help with discovering Lever/Ashby tokens. Not worth it.

3. **Use a third-party ATS index.** [fantastic.jobs](https://fantastic.jobs/api) and [TheirStack](https://theirstack.com/) maintain commercial catalogs covering 220,000+ Greenhouse companies. These are paid services. Useful as a backstop for v1.1+ if curation becomes a chore.

4. **Discover from company careers-page URLs.** A common bootstrap: when the candidate is interested in `<company>`, fetch their careers page, look for `boards.greenhouse.io/<token>` or `jobs.lever.co/<site>` in the HTML/redirect chain, persist the mapping. Implement this as a `discover_ats_board(careers_url)` MCP tool — runs on-demand when the orchestrator hits an unknown company.

Practical recommendation: **start with the curated seed list + the `discover_ats_board` tool**. Crawl-based and paid-index options stay on the V2 shelf.

### Recommended source mix for v1

| Source | Tier | Cadence | Why |
|---|---|---|---|
| Greenhouse public API | A | Every 6h | Best-coverage ATS, free, designed-for-public, stable IDs |
| Lever public API | A | Every 6h | Second-best ATS, free, `workplaceType` first-class |
| Ashby public API | A | Every 6h | AI-native startup density |
| YC Work at a Startup | A | Daily | Vetted YC funding-tier startups |
| HN "Who is Hiring" | A | Monthly batch on thread-publish | Highest-signal founder-direct postings |
| RemoteOK | B | Daily | Remote-focused breadth; attribution required |
| Remotive | B | Twice daily (their cap is 4×/day) | Curated remote tech |
| USAJOBS | B | Daily | Federal civic-tech AI roles, free, narrow |
| LinkedIn guest API | B | Behind feature flag, narrow queries, 5s+ pacing | Massive surface, ToS-managed via logged-out posture |
| JSON-LD direct extractor | B | Targeted per source | Niche AI boards + outlier careers pages |
| Adzuna | B | Daily diagnostic only | Sanity-check for missed coverage |
| Workday CXS | B (v1.1) | — | Enterprise; lower role-density; defer |
| Indeed / Glassdoor | C | — | API dead; not worth scraping risk |
| Wellfound / WTTJ | C | — | Anti-bot heavy; not worth complexity |
| JSearch (RapidAPI) | B (v1.1) | — | Paid; useful for backfill if LinkedIn unreliable |

---

## Q2: Filter input model

The framing was: orchestrator-passes-criteria (A), subagent-reads-profile (B), or hybrid (C).

### What the 2025-2026 multi-agent recipes do

**Anthropic's own multi-agent research system** (June 2025) — the closest published reference architecture to ours — uses **hybrid**. Per [Anthropic engineering writeup](https://engineering.01cloud.com/2025/06/30/claude-meets-the-research-team-inside-anthropics-multi-agent-masterpiece/) and [Simon Willison's summary](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/):

> The lead agent decomposes the input query into sub-questions, then for each subagent provides "specific objectives, output formats, tool usage guidance, and task boundaries." The subagent has its own tool access and decides its own retrieval strategy within those bounds.

This is *not* "orchestrator does everything and the subagent is a pure function." It's "orchestrator gives a brief; subagent has autonomy within that brief, including reading shared context independently."

**LangGraph's supervisor pattern** ([LangGraph supervisor docs](https://reference.langchain.com/python/langgraph-supervisor), [BetterLink Blog 2026](https://eastondev.com/blog/en/posts/ai/20260512-langgraph-multi-agent-supervisor/)) similarly delegates tasks with structured input but allows worker agents to access shared state. The pattern note specifically warns: "Multi-agent systems are expensive… every supervisor turn is a full LLM call before a worker starts. Supervisor pattern is roughly 3x cost of a single agent."

**Implication:** keep the round-trips minimal. Don't make the orchestrator pre-compute filter criteria that the subagent could just look up.

**LangGraph's job-search-flavored examples** — none of the canonical job-search LangGraph examples I could verify treat the candidate profile as a parameter; they treat it as shared state the worker reads.

**CrewAI's agent metaphor** ([CrewAI agent docs](https://agentsindex.ai/blog/crewai-vs-langgraph)) goes even further toward subagent autonomy: each agent has a `goal` and `backstory` and tools, and reasons about its own retrieval strategy. The orchestrator delegates a task, not a recipe.

**The 2025 job-matching academic literature** (e.g., [ConFit v2](https://arxiv.org/html/2502.12361v1), [Resume2Vec](https://www.mdpi.com/2079-9292/14/4/794), [Zero-Shot Resume-Job Matching with LLMs via Structured Prompting](https://www.mdpi.com/2079-9292/14/24/4960)) treats the resume/profile as a static structured input compared against job descriptions. The job-search task there is *matching*, not *discovery*. Different problem, but useful: the structured-profile + free-text-intent decomposition shows up everywhere.

### Why option A (orchestrator pre-computes everything) is wrong here

- **Stale parameters.** If the orchestrator builds a `JDCriteria` payload from `candidate_profile`, that payload is only as fresh as the orchestrator's last profile read. The candidate's profile is the spec for what they want — and that *should* be queryable on demand by any subagent.
- **Brittleness.** Every change to `candidate_profile` schema becomes a coordination cost between orchestrator and subagent.
- **Wastes the subagent's intelligence.** The candidate's "must have / never have" filtering is exactly the judgment work we want the LLM to do — not a series of `WHERE` clauses pre-computed by code.

### Why option B (subagent reads everything itself) is wrong here

- **No way to scope a single run.** Sometimes the orchestrator needs to say "this run is specifically about AI infra roles" or "the candidate just downgraded their willingness to relocate." Pure subagent autonomy loses that signal.
- **Conflates "what the candidate wants" with "what we're doing right now."** The candidate's profile is the *baseline*; today's brief is the *delta*. The architecture should make that distinction explicit.

### Why C (hybrid) wins

The hybrid model directly mirrors Anthropic's multi-agent research recipe: **orchestrator passes a *brief*; subagent uses tools to fetch its own structured context.**

**The brief** is a short free-text intent string:
> "Remote senior AI/ML engineer roles in the US, $200k+ TC, prefer AI-native product companies, avoid enterprise sales orgs. Surface anything new since last scrape."

**The subagent reads `candidate_profile`** via an MCP tool (call it `get_candidate_profile()`) for structured rules:
- target role keywords (`["AI engineer", "ML engineer", "Staff Software Engineer", "Senior Software Engineer"]`)
- locations / remote preferences
- comp floor (numeric, currency)
- experience anchors (years, levels, language proficiencies)
- must-have technologies
- never-have flags (e.g., "no defense contractors", "no crypto", "no enterprise sales orgs")

**The subagent decides its own query strategy** based on the brief + profile:
- Which sources to hit this run (e.g., "post-HN-thread monthly batch" vs "incremental ATS poll")
- Which keywords to use per source (ATS APIs filter on `team`/`department` differently from LinkedIn's `keywords`)
- How aggressive to be about negative filtering (today's brief says "avoid enterprise sales orgs" but profile may not encode that)

This is also what STRATEGY.md §17 already implies for other subagents: they read their structured context via MCP tools, not as static payloads.

> **Recommendation: Option C (hybrid).** Define an MCP tool `get_candidate_profile()` that returns the structured profile. Orchestrator calls `scrape-jobs` with a short brief; `scrape-jobs` calls `get_candidate_profile()` once on startup to load structured rules, then executes its retrieval strategy.

### Concrete interface

```
# Orchestrator → scrape-jobs invocation
{
  "brief": "Daily incremental scan. Focus on AI/ML and infra roles. The candidate just added FastAPI and Postgres to their stack — boost matches that touch those.",
  "max_new_leads": 20,           # cap to control LLM cost per run
  "sources": ["greenhouse", "lever", "ashby"],  # optional override; default = profile-driven
  "since": "2026-05-26T00:00:00Z"  # optional incremental anchor
}

# scrape-jobs internally calls:
get_candidate_profile() → structured profile
list_known_boards(source=...) → board tokens to poll
record_job_lead(...) → insert / upsert into job_leads
```

This pattern also gives us a clean test boundary: the brief is a string, the profile is fetched, the subagent's job is "translate brief + profile into source queries → fetched JSON → recorded leads."

---

## Q3: Dedup + schema

### The dedup problem, layered

There are three classes of duplicate to handle:

1. **Same posting, same source, polled multiple times.** Easy: stable `(source, source_job_id)` natural key with PostgreSQL `ON CONFLICT (source, source_job_id) DO UPDATE` semantics.
2. **Same posting, different sources.** A single role posted to Greenhouse, then re-syndicated to LinkedIn, RemoteOK, and Adzuna. Each source has its own ID space; canonical content overlaps but with formatting drift. Needs content-fingerprint matching.
3. **Same posting, refreshed by employer.** Some companies re-post the same role weekly to bump it back to the top of aggregators. Same content, new IDs, different `posted_at`. This actually behaves like (1) within-source (if the source replaces the listing) or (2) cross-source (if the source treats it as new). Handle as (2).

### Lessons from the field

- **Per [PromptCloud's job aggregation guide (2026)](https://www.promptcloud.com/blog/job-posting-data-aggregation/):** "Exact-match deduplication on job ID is ineffective because each platform assigns its own internal ID to the same listing. Real deduplication requires fuzzy matching across title, company name, location, and description, tolerating minor variations while catching genuine duplicates."
- **Per [HasData production-scraper guide](https://dev.to/hasdata_com/building-a-production-ready-job-board-scraper-with-python-pgd):** Use `source + ":" + id` as a stable composite dedup key for within-source; do a secondary cross-source pass that hashes normalized title+company+location.
- **Hashing technique:** [MinHash + LSH](https://milvus.io/blog/minhash-lsh-in-milvus-the-secret-weapon-for-fighting-duplicates-in-llm-training-data.md) for fuzzy text similarity; SimHash for fixed-length cosine-similarity approximation. For our scale (probably <50k active leads at any time), we don't need LSH — a SimHash 64-bit fingerprint with Hamming distance ≤3 is enough, computed at insert time and indexed.

### Recommended `job_leads` schema

```sql
CREATE TABLE job_leads (
  -- Identity
  id                  BIGSERIAL PRIMARY KEY,
  source              TEXT NOT NULL,           -- 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'hn-whoishiring' | 'yc-was' | 'linkedin-guest' | 'remoteok' | 'remotive' | 'usajobs' | 'adzuna' | 'jsearch' | 'jsonld'
  source_board_token  TEXT,                    -- e.g., the Greenhouse board_token; NULL for non-ATS
  source_job_id       TEXT NOT NULL,           -- Greenhouse `id`, Lever `id`, HN comment id, etc.
  source_url          TEXT NOT NULL,           -- canonical apply URL on source
  apply_url           TEXT,                    -- distinct apply URL if different
  UNIQUE (source, source_job_id),              -- within-source dedup key

  -- Content fingerprint for cross-source dedup
  content_fingerprint BIGINT NOT NULL,         -- 64-bit SimHash over normalize(title + company + location + description_trimmed)
  fingerprint_cluster_id BIGINT,               -- nullable; populated by background dedup job; points to canonical lead

  -- Core fields (normalized)
  title               TEXT NOT NULL,
  company             TEXT NOT NULL,
  company_domain      TEXT,                    -- canonical company identifier when we can derive one
  location_raw        TEXT,                    -- as published
  is_remote           BOOLEAN,                 -- nullable; only populated when source explicitly states
  workplace_type      TEXT,                    -- 'remote' | 'hybrid' | 'onsite' | NULL
  remote_region       TEXT,                    -- 'US' | 'EU' | 'GLOBAL' | NULL — parsed from text
  employment_type     TEXT,                    -- 'full-time' | 'contract' | 'intern' | NULL

  -- Comp (all nullable)
  comp_min_usd        INTEGER,
  comp_max_usd        INTEGER,
  comp_currency       TEXT DEFAULT 'USD',
  comp_period         TEXT,                    -- 'year' | 'hour' | 'month'
  has_equity          BOOLEAN,

  -- Free-text
  description_html    TEXT,
  description_text    TEXT,                    -- stripped + normalized for fingerprint + embedding

  -- Lifecycle timestamps
  source_posted_at    TIMESTAMPTZ,             -- as published by source
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,             -- set when source returns 404/410 OR posting absent from N consecutive feed polls
  closed_reason       TEXT,                    -- 'http_404' | 'feed_absent' | 'manual' | NULL

  -- Scoring (cheap, computed at insert)
  rules_score         INTEGER,                 -- 0–100, see below
  rules_score_reasons JSONB,                   -- {"keyword_match": ["AI engineer"], "comp_above_floor": true, "neg_flag_hit": null}

  -- LLM scoring (lazy, computed at draw time)
  llm_score           INTEGER,                 -- 0–100, nullable until orchestrator scores it
  llm_score_reasons   JSONB,                   -- {"why_match": "...", "concerns": ["..."], "confidence": "high"}
  llm_scored_at       TIMESTAMPTZ,
  llm_scored_brief_hash TEXT,                  -- so we know to re-score if the brief that produced this score has changed

  -- Funnel state (foreign-key bridge to applications)
  status              TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'reviewed' | 'queued' | 'applied' | 'rejected' | 'archived'
  status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  application_id      BIGINT REFERENCES applications(id),  -- nullable until applied

  -- Raw payload (for re-parsing if our normalization improves)
  raw_payload         JSONB
);

-- Indexes
CREATE INDEX idx_job_leads_source_lookup ON job_leads (source, source_job_id);
CREATE INDEX idx_job_leads_fingerprint   ON job_leads (content_fingerprint);
CREATE INDEX idx_job_leads_active_recent ON job_leads (status, closed_at, first_seen_at DESC) WHERE closed_at IS NULL;
CREATE INDEX idx_job_leads_rules_score   ON job_leads (rules_score DESC) WHERE status = 'new' AND closed_at IS NULL;
CREATE INDEX idx_job_leads_company       ON job_leads (company);
```

### Design notes

1. **`(source, source_job_id)` is the primary natural key.** Patterns documented in [PostgreSQL ON CONFLICT walkthrough](https://www.beekeeperstudio.io/blog/postgres-on-conflict) and explicitly recommended by [HasData's production scraper guide](https://dev.to/hasdata_com/building-a-production-ready-job-board-scraper-with-python-pgd). On each poll: `INSERT … ON CONFLICT (source, source_job_id) DO UPDATE SET last_seen_at = NOW(), description_html = EXCLUDED.description_html, …`.

2. **Cross-source dedup is a *separate* concern handled by a background job.** Computing `content_fingerprint = simhash64(normalize(title + company + location + description[:2000]))` at insert is cheap; cluster assignment (`fingerprint_cluster_id`) runs as a periodic batch that finds postings within Hamming distance ≤3 and unifies them. Do *not* try to dedup cross-source synchronously — premature optimization that wastes LLM budget on the slow path.

3. **Never hard-delete.** Per [Coresignal](https://coresignal.com/blog/how-to-find-old-job-postings/) and [PromptCloud](https://www.promptcloud.com/blog/job-posting-data-aggregation/), historical data is itself useful (funnel analytics, "I applied 3 months ago, are they posting again?", market timing). `closed_at` is a soft-delete with reason.

4. **Closed-detection mechanism:**
   - **For ATS direct (Greenhouse/Lever/Ashby):** poll the list endpoint; postings absent from the feed for 2 consecutive polls → set `closed_at = NOW()`, `closed_reason = 'feed_absent'`.
   - **For URL-fetched sources (HN, LinkedIn guest, JSON-LD):** spot-check open postings via HEAD requests; 404/410 → close.
   - **For aggregator APIs (RemoteOK, Adzuna):** rely on `validThrough` field where present; absence-from-feed otherwise.

5. **Why store both `rules_score` (cheap, at insert) AND `llm_score` (lazy, at draw)?** The cheap score filters the pool fast; the LLM score is reserved for the candidates the orchestrator actually surfaces in the briefing. This is the same pattern as cheap-then-expensive retrieval in RAG: pre-filter cheaply, score expensively only on the shortlist.

6. **Rules score components (suggested defaults; configurable per `system_modes`):**
   - Keyword match on `candidate_profile.target_keywords`: +30 max
   - Compensation above floor: +20
   - Location match (remote-US, candidate-state, etc.): +15
   - Recency (≤24h: +15, ≤7d: +10, ≤30d: +5): +15
   - Negative-keyword match: −100 (effective drop)
   - Source tier multiplier (HN: ×1.2, ATS direct: ×1.1, aggregator: ×0.9): post-sum
   - Cap at 0–100.

7. **`llm_scored_brief_hash` matters.** When the candidate's brief changes (different focus this week), previously-scored leads should be re-scored if the orchestrator re-surfaces them. Hashing the brief lets us cheaply detect "score is stale relative to current brief" without storing the brief text per lead.

### Schema deltas vs STRATEGY.md §15

The STRATEGY.md spec currently scopes `applications` and `candidate_profile` tables. `job_leads` is a new addition that bridges them: `scrape-jobs` writes to `job_leads`; when the orchestrator (or candidate) promotes a lead, it creates an `applications` row referencing `job_leads.id`. This keeps the funnel "discovered → considered → applied" cleanly modeled and prevents application-row pollution from leads that never become applications.

---

## Q4: Surfacing pattern

The framing was: backend pool vs chat surface, and on what cadence, and where ranking happens.

### What 2025-2026 autonomous job-search systems do

Two patterns dominate:

1. **Push-on-trigger (notification-style):** Agent monitors continuously, fires a message when a hit clears a threshold. Examples: [Daily Briefing morning-agent recipes from LangChain templates](https://www.langchain.com/templates/daily-calendar-brief), [LangSmith Agent Builder daily-cadence digests](https://blog.langchain.com/langsmith-agent-builder-now-in-public-beta/).
2. **Pull-on-demand (digest-style):** Agent maintains a fresh pool; user (or another agent) reads from it on a schedule. Examples: [Dume morning briefing](https://docs.dume.ai/system-workflows/morning-briefing), [n8n daily email digest](https://n8n.io/workflows/5003-daily-email-digest-with-ai-summarization-using-gmail-openrouter-and-langchain/).

The pragmatic answer in the surveyed systems is "both, layered." A pool that's fresh + a daily push digest + a high-threshold instant push.

### What the *cost* curve looks like

Per [DEV Community agent-scheduling guide](https://dev.to/thedailyagent/how-to-schedule-ai-agents-that-run-themselves-1a2f): "Over-scheduling burns money — if your agent runs every 5 minutes but the underlying data only changes once a day, you are paying for 287 wasted executions; match the frequency to how often the data actually changes."

Job-posting data changes:
- ATS feeds: new postings appear continuously, but the rate of *senior IC* postings at *any one company* is single-digit per week.
- HN: thread is published once per month; comments roll in over 1-3 days.
- Aggregators: 24h+ delay in many cases (Remotive explicitly delays 24h).

So the actual cadence floor is:

| Source class | Real freshness | Polling cadence |
|---|---|---|
| ATS direct (Greenhouse, Lever, Ashby) | Hours | Every 6h on weekdays, 12h on weekends |
| HN Who is Hiring | Monthly | One batch run on thread-publish |
| YC Work at a Startup | Daily | Daily |
| RemoteOK, Remotive | Daily (per their advice) | Daily / 2× per day max |
| LinkedIn guest | Hourly tops | On-demand only, narrow queries; behind feature flag |
| Aggregators (Adzuna, JSearch) | Daily | Daily as diagnostic backfill |

### The pool-first architecture

> **Recommendation: pool-first, with two complementary surfaces on top.**

1. **The pool.** `scrape-jobs` runs on a cron-style schedule (Phase 2.5 uses NanoClaw's scheduling — confirm against STRATEGY.md §V Phase 4 scheduling primitives) and writes to `job_leads`. Each insert computes `rules_score` cheaply. *No LLM score is computed at insert*; the pool stays cheap.

2. **The daily briefing (pull).** Orchestrator (per STRATEGY.md Phase 3 daily-briefing flow) at 8am local:
   - `SELECT FROM job_leads WHERE status='new' AND closed_at IS NULL AND rules_score >= threshold ORDER BY rules_score DESC, first_seen_at DESC LIMIT 30`
   - LLM-scores those 30 against the candidate's *current* brief (one prompt; structured `{score, why_match, concerns}` output)
   - Surfaces the top 5-10 in the morning Telegram message
   - Updates `llm_score`, `llm_score_reasons`, `llm_scored_brief_hash` for the scored set
3. **The killer-match push (event).** Within `scrape-jobs`, after each insert, if `rules_score >= 90 AND source_posted_at within last 6h AND source in (greenhouse, lever, ashby, hn)`, enqueue an immediate orchestrator notification. This catches the "founder posted this 20 minutes ago" case where speed actually matters (early-stage YC roles, particularly).

### Why scoring happens at draw time, not insert time

- **The brief is what changes most.** The candidate's daily focus drifts (this week: "more interested in early-stage"; next week: "downshift, want larger-stage stability"). If we baked LLM scores at insert, every brief-change would require a full re-score.
- **We already pay for LLM tokens at briefing time.** Adding ranking is incremental; deferring all ranking to that moment means at-insert is *all* cheap deterministic rules.
- **It matches how recruiters actually behave.** Recruiters don't read the entire candidate-search universe daily; they sweep the new arrivals and the high-scoring fresh-ish set. We mirror that.
- **Cheap rules filtering is robust.** The expensive LLM step only sees ~30 leads/day even if 200 new leads came in — the LLM cost stays predictable.

### Why a chat-surface-first design would fail here

Imagine `scrape-jobs` runs and *immediately* posts every match into the Telegram channel. Two failure modes:

- **Volume blow-up.** A new YC batch publishing 50 fresh `Ashby` listings in a single day floods the channel.
- **Score drift.** A posting that's an A-grade match now might become a B-grade match in a week as the candidate's brief evolves; locking-in chat history makes the user re-read old surfaces.

The pool-first design avoids both by separating *discovery* (durable) from *attention* (ephemeral, brief-driven).

### Cadence calendar (concrete v1)

| Cron | Action |
|---|---|
| `0 */6 * * 1-5` (every 6h Mon-Fri) | `scrape-jobs --sources=greenhouse,lever,ashby --mode=incremental` |
| `0 8 * * *` (8am daily) | Orchestrator daily-briefing: pulls top 30 from pool, LLM-scores, surfaces top 5-10 |
| `0 12,18 * * *` (noon + 6pm) | `scrape-jobs --sources=remoteok,remotive,usajobs --mode=incremental` |
| `0 12 * * 6,0` (noon Sat+Sun) | `scrape-jobs --sources=all-tier-A --mode=full` |
| On-demand | Killer-match push (rules_score ≥ 90, recent, tier-A source) → orchestrator notify immediately |
| `0 16 1 * *` (4pm first day of month) | `scrape-jobs --sources=hn-whoishiring --mode=batch` (HN publishes 11am Eastern first business day; we wait until afternoon to let comments roll in) |
| Weekly: Sundays | Background dedup job: compute fingerprint clusters, mark `closed_at` for feed-absent leads |

### Tie-in to STRATEGY.md Phase 3 daily-briefing flow

This pool-first surfacing model assumes Phase 3's daily-briefing primitive exists (orchestrator can be scheduled and can render structured output to Telegram). Phase 2.5 itself only needs to build:
- The polling/inserter loop for `scrape-jobs`
- The `job_leads` schema + dedup machinery
- The cheap rules-scorer
- The `record_job_lead` / `query_job_leads` MCP tools

LLM scoring + briefing rendering land in Phase 3. The pool is useful even before Phase 3 (the candidate can `SELECT FROM job_leads` ad-hoc to see what `scrape-jobs` is finding).

> **Recommendation:** pool-first with rules-tier-A scoring at insert; LLM ranking lazy at draw time; killer-match push as a small additive event surface; cadence calendar as above.

---

## Cross-cutting operational tactics

A few non-question-aligned operational concerns surfaced repeatedly during research. These are not specs themselves but should inform the Phase 2.5 spec when it's written.

### LinkedIn pacing and backoff

If we include LinkedIn at all (Tier B, behind feature flag), the operational rules are non-negotiable:

- **5-second floor between requests** to the same `seeMoreJobPostings/search` host. Realistic per [iProyal 2026 LinkedIn-scrape guide](https://iproyal.com/blog/web-scraping-linkedin/) and [DEV agenthustler 2026 logged-out guide](https://dev.to/agenthustler/how-to-scrape-linkedin-job-listings-in-2026-public-data-without-login-5094).
- **Exponential backoff on 429/999/CAPTCHA.** A 999 response is LinkedIn's "you're noticed" signal. On a 999: stop the LinkedIn worker for ≥6h, log, alert the operator.
- **Narrow queries only.** LinkedIn caps depth at ~1,000 results regardless of total matches. Use `keywords + location + f_TPR=r604800` (past week) + `f_E=4,5,6` (mid-senior-director levels) to keep result sets <500.
- **No account creation, ever.** Per the [hiQ wrap-up](https://blog.apify.com/hiq-v-linkedin/) and *Meta v. Bright Data* analysis above, scraper accounts are the bright-line move that converts Tier B into "actively litigable." We never sign in.
- **User-agent rotation is fine; residential proxies are unnecessary at our volume.** Personal-use volume (one candidate, narrow queries, hourly tops) won't trip volumetric defenses with a single residential IP. If we do trip them, that's a signal to back off, not a signal to invest in proxy infrastructure.

### Rules-score formula (concrete v1 default)

To make `rules_score` deterministic and inspectable, here's the proposed scoring function. Each component returns 0–N, summed, clipped to 0–100. Stored alongside `rules_score_reasons` for explainability.

```
def rules_score(job, profile, brief):
    score = 0
    reasons = {}

    # Keyword match: target_keywords on title + description (first 2000 chars)
    title_hits = count_matches(profile.target_keywords, job.title)
    desc_hits  = count_matches(profile.target_keywords, job.description_text[:2000])
    kw_score   = min(30, 15 * title_hits + 3 * desc_hits)
    reasons["keyword_match"] = {"score": kw_score, "title_hits": title_hits, "desc_hits": desc_hits}
    score += kw_score

    # Compensation floor: if comp_min_usd is present and >= profile.comp_floor_usd
    if job.comp_min_usd is None and job.comp_max_usd is None:
        comp_score = 5  # unknown — half-credit, since absence is common
    elif (job.comp_max_usd or job.comp_min_usd) >= profile.comp_floor_usd:
        comp_score = 20
    else:
        comp_score = 0  # below floor; do not penalize harder
    reasons["comp"] = {"score": comp_score, "comp_min_usd": job.comp_min_usd, "comp_max_usd": job.comp_max_usd}
    score += comp_score

    # Location: remote-friendly + region match
    if job.is_remote is True and (job.remote_region in profile.acceptable_regions):
        loc_score = 15
    elif job.is_remote is True:
        loc_score = 8
    elif job.location_raw and any(c in job.location_raw for c in profile.acceptable_cities):
        loc_score = 15
    else:
        loc_score = 0
    reasons["location"] = {"score": loc_score, "is_remote": job.is_remote, "remote_region": job.remote_region}
    score += loc_score

    # Recency
    age_hours = (now() - (job.source_posted_at or job.first_seen_at)).total_hours
    if   age_hours <= 24:  rec_score = 15
    elif age_hours <= 168: rec_score = 10  # 1 week
    elif age_hours <= 720: rec_score = 5   # 30 days
    else:                  rec_score = 0
    reasons["recency"] = {"score": rec_score, "age_hours": int(age_hours)}
    score += rec_score

    # Negative-keyword hits (hard cutoff)
    neg_hits = match_any(profile.negative_keywords, job.title + " " + job.description_text[:2000])
    if neg_hits:
        reasons["neg_flag"] = {"hits": neg_hits, "effect": "drop"}
        return 0, reasons  # short-circuit

    # Source tier multiplier
    multipliers = {
        "greenhouse": 1.1, "lever": 1.1, "ashby": 1.1, "workday": 1.0,
        "yc-was": 1.15, "hn-whoishiring": 1.2,
        "remoteok": 0.95, "remotive": 0.95, "usajobs": 0.95,
        "linkedin-guest": 0.9, "adzuna": 0.85, "jsearch": 0.85, "jsonld": 0.95,
    }
    mult = multipliers.get(job.source, 1.0)
    final = min(100, int(score * mult))
    reasons["source_mult"] = {"source": job.source, "multiplier": mult}

    return final, reasons
```

The multiplier weights are deliberately gentle; the goal is to slightly favor sources where the candidate-facing posting was author-direct (HN founders, YC WaaS founder posts) over distributed aggregators. They're configurable via `config/defaults.json` (per STRATEGY.md §20 config tier model).

### Handling description normalization for SimHash

For `content_fingerprint` to actually catch cross-source duplicates, the input to SimHash must be normalized identically across sources. Concrete rules:

1. Lowercase everything.
2. Strip HTML tags (descriptions arrive as both HTML and plain text depending on source).
3. Collapse all whitespace to single spaces.
4. Truncate to first 4000 chars of description body (most distinguishing content is at the top).
5. Concatenate: `f"{normalize(title)}\n{normalize(company)}\n{normalize(location_raw)}\n{normalize(description_text)}"`.
6. SimHash → 64-bit unsigned int → store as `BIGINT` (PostgreSQL BIGINT is signed 8-byte; cast carefully).

The reason for normalizing *before* SimHashing rather than relying on SimHash's tolerance: source descriptions diverge enough (different intro paragraphs, different signature blocks, different company-name spelling) that without pre-normalization, even genuine duplicates wander outside Hamming distance ≤3.

### Token-cost economics

Per [the project's existing memory note on Claude validation cost](C:\Users\alago\.claude\projects\C--Projects-career-pilot\memory\reference_claude_validation_cost.md), Phase 2.x runs landed at ~$0.75 per validation. Phase 2.5 `scrape-jobs` runs need a budget envelope. Rough estimate:

- **One ATS poll cycle (Greenhouse+Lever+Ashby, ~200 boards):** ~200 HTTP fetches × ~10KB JSON = ~2MB traffic; no LLM token cost (pure ingest + cheap normalize + rules-score).
- **One HN month batch (~600 comments):** Either parse with regex+heuristics (no LLM cost) or one batched LLM extraction over chunks of comments (~$0.30 with Haiku/Sonnet, one-shot per month).
- **Daily briefing LLM rank (top 30 leads, one prompt):** ~30 short summaries (~5KB each) + brief → one Claude call → ~$0.05-0.15 depending on tier.

**Forecast Phase 2.5 monthly spend:** $5-15 in LLM tokens for normal operation, dominated by daily briefing scoring. Acceptable.

### Cross-cutting: honoring `robots.txt` even when not required

The robots.txt fetches above (Lever `Crawl-delay: 1`, Greenhouse `/embed/` disallowed) are non-binding from a CFAA standpoint per [hiQ](https://law.justia.com/cases/federal/appellate-courts/ca9/17-16783/17-16783-2022-04-18.html), but the cultural norm — and the operational signal — is to respect them. The recommendation: implement a `respect_robots_txt: true` config flag in `scrape-jobs`, default-on, that fetches and caches each domain's robots.txt once per 24h and uses it to derive the per-domain crawl-delay floor. Cost is negligible; the goodwill (and the legal-defense narrative) is worth it.

---

## Phase 2.5 implementation map

To translate this research into Phase 2.5 implementation, the work decomposes into:

1. **Spec deltas (no code).**
   - Update STRATEGY.md §15 to add `job_leads` table.
   - Update STRATEGY.md §V Phase 2.5 milestone to reference this research file as the source for source-mix, cadence, dedup, scoring, and the ATS-discovery seed list.
   - Add `groups/career-pilot/.claude/agents/scrape-jobs.md` subagent prompt + tool palette.
   - Add VERIFICATION.md DoD entries for `scrape-jobs` (mirroring the established subagent VERIFICATION pattern from Phase 2.3).

2. **DB migration (one file).**
   - `src/db/migrations/NNNN_job_leads.ts` with the schema above + indexes + initial seed-list table (if we store ATS targets in DB rather than JSON file — leaning JSON file in `groups/career-pilot/data/` for ease of version control).

3. **MCP tools (5 new, deltas to existing).**
   - `record_job_lead(payload)` — upsert one lead by `(source, source_job_id)`.
   - `query_job_leads(filters)` — orchestrator's draw-from-pool surface; supports `status`, `rules_score_min`, `since`, `source`, `not_yet_llm_scored`, `limit`.
   - `update_job_lead_status(id, status, reason)` — funnel transitions.
   - `discover_ats_board(careers_url)` — given a careers page URL, return the ATS provider + token if detectable.
   - `get_candidate_profile()` — extend existing or add; returns the structured profile needed for filtering.

4. **Source-adapter modules (one per Tier-A source for v1).**
   - `src/scrape-jobs/sources/greenhouse.ts`
   - `src/scrape-jobs/sources/lever.ts`
   - `src/scrape-jobs/sources/ashby.ts`
   - `src/scrape-jobs/sources/hn-whoishiring.ts`
   - `src/scrape-jobs/sources/yc-was.ts`
   - Each implements a common `{ list, fetchDetails, normalize }` interface.

5. **Scheduling glue.**
   - Cron expressions per the cadence calendar above.
   - Wired into NanoClaw's scheduling layer (Phase 2.5 may need to import the scheduling primitive Phase 3 was going to add; defer if not yet available and run `scrape-jobs` on-demand from the orchestrator for v1.0).

6. **Background dedup job.**
   - Sunday weekly: scan recent inserts, compute fingerprint clusters via Hamming distance ≤3, populate `fingerprint_cluster_id`.
   - Same job: mark `closed_at = NOW()` for any lead with `last_seen_at < NOW() - INTERVAL '2 polls'` (compute per-source).

7. **Verification.**
   - `--flow=scrape-jobs-incremental` end-to-end test (e2e parallel to Phase 2.3's `--flow=draft-outreach`): orchestrator triggers `scrape-jobs` with a brief; subagent polls 3 known Greenhouse boards; results land in `job_leads`; rules scores computed.
   - Snapshot test of the rules-score formula against fixture jobs.
   - SimHash sanity test: same job from Greenhouse vs RemoteOK produces fingerprints within Hamming-3.

Order of execution mirrors the precedent from Phase 2.3: spec deltas first, then DB + MCP tools, then source adapters, then scheduling, then verification.

---

## Sources cited

### Court rulings + legal posture
- [HiQ Labs, Inc. v. LinkedIn Corp., No. 17-16783 (9th Cir. 2022)](https://law.justia.com/cases/federal/appellate-courts/ca9/17-16783/17-16783-2022-04-18.html)
- [Apify legal analysis: hiQ v LinkedIn wrap-up](https://blog.apify.com/hiq-v-linkedin/)
- [Morgan Lewis: LinkedIn v. hiQ landmark guidance (2022-12)](https://www.morganlewis.com/blogs/sourcingatmorganlewis/2022/12/linkedin-v-hiq-landmark-data-scraping-suit-provides-guidance-to-data-scrapers-and-web-operators)
- [EFF: Scraping Public Websites Still Isn't a Crime (2022)](https://www.eff.org/deeplinks/2022/04/scraping-public-websites-still-isnt-crime-court-appeals-declares)
- [Jenner & Block: hiQ v. LinkedIn CFAA reaffirmation](https://www.jenner.com/en/news-insights/publications/client-alert-data-scraping-in-hiq-v-linkedin-the-ninth-circuit-reaffirms-narrow-interpretation-of-cfaa)
- [Bright Data press: Court rules in favor of Bright Data (Meta v. Bright Data, Jan 2024)](https://www.prnewswire.com/news-releases/court-rules-in-favor-of-bright-data-in-meta-v-bright-data-case-reaffirming-the-right-to-collect-public-web-data-302043730.html)
- [TechCrunch: Court rules in favor of Bright Data (Jan 2024)](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued/)
- [Farella Braun + Martel: Recent rulings in hiQ v LinkedIn and related cases](https://www.fbm.com/publications/what-recent-rulings-in-hiq-v-linkedin-and-other-cases-say-about-the-legality-of-data-scraping/)
- [GroupBWT: Web Scraping Legal Issues 2025 Enterprise Compliance Guide](https://groupbwt.com/blog/is-web-scraping-legal/)

### ATS public APIs
- [Greenhouse Job Board API documentation](https://developers.greenhouse.io/job-board.html)
- [Greenhouse Harvest API rate-limiting docs](https://harvestdocs.greenhouse.io/docs/api-rate-limiting) (confirms Job Board API is "publicly accessible, cached, not rate limited")
- [Lever postings-api repo + docs](https://github.com/lever/postings-api/blob/master/README.md)
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Ashby Developer API updates (June 2025)](https://www.ashbyhq.com/product-updates/developer-api-updates)
- [Workday Scraper API guide (jobo.world)](https://jobo.world/ats/workday)
- [HasData: Building a Production-Ready Job Board Scraper with Python (DEV)](https://dev.to/hasdata_com/building-a-production-ready-job-board-scraper-with-python-pgd)
- [SmartRecruiters Job Board API docs](https://developers.smartrecruiters.com/docs/partners-job-board-api)
- [fantastic.jobs: 6 ATS Platforms with Public Job Posting APIs](https://fantastic.jobs/article/ats-with-api)
- [TheirStack: Companies that use Greenhouse (26,500+)](https://theirstack.com/en/technology/greenhouse)
- [Index.dev: Greenhouse vs Lever vs Ashby (2026)](https://www.index.dev/blog/greenhouse-vs-lever-vs-ashby-ats-comparison)

### Aggregator APIs
- [Adzuna API overview](https://developer.adzuna.com/overview)
- [Adzuna ToS](https://developer.adzuna.com/docs/terms_of_service)
- [JSearch (RapidAPI)](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch)
- [OpenWeb Ninja JSearch (direct portal)](https://www.openwebninja.com/api/jsearch)
- [Jooble REST API documentation](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation)
- [USAJOBS API reference](https://developer.usajobs.gov/api-reference/)
- [Reed Jobseeker API docs](https://www.reed.co.uk/developers/Jobseeker)
- [Findwork.dev (PublicAPI listing)](https://publicapi.dev/findwork-api)

### Curated / niche / remote-focused
- [Hacker News Firebase API repo](https://github.com/HackerNews/API)
- [Algolia HN API (faster thread fetch)](https://hn.algolia.com/api)
- [HN: Ask HN Who is Hiring (Dec 2025 example)](https://news.ycombinator.com/item?id=46108941)
- [HNHIRING.com index](https://hnhiring.com/)
- [brmeyer/hacker-news-who-is-hiring-parser](https://github.com/brmeyer/hacker-news-who-is-hiring-parser)
- [Y Combinator Work at a Startup](https://www.workatastartup.com/)
- [Apify YC Work at a Startup scraper](https://apify.com/scrapepilot/yc-startup-jobs-scraper----companies-jobs-founders)
- [Nneji123 YC scraper (Python)](https://github.com/Nneji123/ycombinator-scraper)
- [RemoteOK public API](https://remoteok.com/api)
- [Remotive public jobs API](https://remotive.com/api/remote-jobs)
- [Welcome to the Jungle (post-Otta merger)](https://employers.welcometothejungle.com/companies/welcome-to-the-jungle)
- [Tech.eu: Welcome to the Jungle acquires Otta (Jan 2024)](https://tech.eu/2024/01/22/welcome-to-the-jungle-acquires-job-search-platform-otta/)
- [Scrapfly: How to Scrape Wellfound (AngelList)](https://scrapfly.io/blog/posts/how-to-scrape-wellfound-aka-angellist)
- [subbuwu/wellfound_graphqlscout (GraphQL reverse-engineered)](https://github.com/subbuwu/wellfound_graphqlscout)
- [aijobs.com](https://aijobs.com/) (JSON-LD JobPosting niche board)
- [Karkidi.com](https://www.karkidi.com/) (AI/ML/DS niche)
- [Levels.fyi API access](https://www.levels.fyi/api-access/)

### LinkedIn / Indeed / Glassdoor (2026 status)
- [DEV: How to Scrape LinkedIn Job Listings in 2026 (logged-out guest API)](https://dev.to/agenthustler/how-to-scrape-linkedin-job-listings-in-2026-public-data-without-login-5094)
- [iProyal: How to Scrape LinkedIn Data in 2026](https://iproyal.com/blog/web-scraping-linkedin/)
- [Apify LinkedIn Jobs Scraper (no login)](https://apify.com/cryptosignals/linkedin-jobs-scraper)
- [JobSpy GitHub (multi-source Python scraper)](https://github.com/speedyapply/JobSpy)
- [JobSpy MCP server](https://github.com/lowcoordination/jobspy_mcp_server)
- [DEV: Glassdoor API in 2026 - Why Devs Are Switching to Web Scraping](https://dev.to/agenthustler/glassdoor-api-in-2026-why-developers-are-switching-to-web-scraping-na0)
- [JobsPikr: Beyond Indeed API](https://www.jobspikr.com/blog/beyond-indeed-api-discovering-powerful-alternatives-for-job-aggregation/)
- [dstribute.io: Google Jobs Shake-Up 2025 (indexing API restrictions)](https://dstribute.io/job-boards/google-jobs-shake-up-2025-navigating-the-new-indexing-api-restrictions/)

### Schema.org / JSON-LD / direct careers pages
- [Schema.org JobPosting type](https://schema.org/JobPosting)
- [Google Search Central: JobPosting structured data docs](https://developers.google.com/search/docs/appearance/structured-data/job-posting)
- [Skeptric: Schemas for JobPostings in Practice](https://skeptric.com/schema-jobposting/)

### Dedup + schema
- [PromptCloud: Job Posting Data Aggregation Multi-Source Guide for 2026](https://www.promptcloud.com/blog/job-posting-data-aggregation/)
- [Coresignal: How to Find Old Job Postings](https://coresignal.com/blog/how-to-find-old-job-postings/)
- [PostgreSQL ON CONFLICT walkthrough (Beekeeper Studio)](https://www.beekeeperstudio.io/blog/postgres-on-conflict)
- [Milvus: MinHash LSH for Duplicates in LLM Training Data](https://milvus.io/blog/minhash-lsh-in-milvus-the-secret-weapon-for-fighting-duplicates-in-llm-training-data.md)
- [In Defense of MinHash Over SimHash (arXiv 2014)](https://arxiv.org/pdf/1407.4416)

### Agent design references
- [Anthropic engineering: How we built our multi-agent research system](https://engineering.01cloud.com/2025/06/30/claude-meets-the-research-team-inside-anthropics-multi-agent-masterpiece/)
- [Simon Willison summary: Multi-agent research system](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)
- [LangGraph Multi-Agent Supervisor docs](https://reference.langchain.com/python/langgraph-supervisor)
- [LangGraph supervisor pattern in practice (BetterLink blog 2026)](https://eastondev.com/blog/en/posts/ai/20260512-langgraph-multi-agent-supervisor/)
- [LangChain Daily Briefing template](https://www.langchain.com/templates/daily-calendar-brief)
- [LangSmith Agent Builder Public Beta](https://blog.langchain.com/langsmith-agent-builder-now-in-public-beta/)
- [DEV: How to Schedule AI Agents That Run Themselves](https://dev.to/thedailyagent/how-to-schedule-ai-agents-that-run-themselves-1a2f)
- [CrewAI vs LangGraph (agentsindex)](https://agentsindex.ai/blog/crewai-vs-langgraph)

### Job-match scoring (academic / 2025)
- [Zero-Shot Resume-Job Matching with LLMs via Structured Prompting (MDPI 2025)](https://www.mdpi.com/2079-9292/14/24/4960)
- [Resume2Vec (MDPI 2025)](https://www.mdpi.com/2079-9292/14/4/794)
- [ConFit v2 (arXiv 2025)](https://arxiv.org/html/2502.12361v1)

### Robots.txt (live fetches, 2026-05-27)
- `https://jobs.lever.co/robots.txt` — `Crawl-delay: 1`; ai-train=no; explicitly disallows GPTBot/ClaudeBot/Bytespider/etc. but allows generic agents.
- `https://boards.greenhouse.io/robots.txt` — disallows only `/embed/`; no crawl-delay set.
