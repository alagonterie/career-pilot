# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the **product** version line. It is independent of the vendored NanoClaw
fork version recorded in `package.json` — the two are never conflated.

<!-- On cutover: move the accumulated Unreleased items into a new version
     section, and set [1.0.0]'s date to the actual release date before tagging. -->

## [Unreleased]

### Added

- **Standby mode.** A deliberate, reversible pause for when the job search
  isn't running: the public site becomes a single page that says so plainly
  and still offers a way to make contact, and the cloud VM behind it is
  stopped rather than left idling. Controlled from an owner-only console that
  runs entirely at the edge, so it keeps working while the backend is off —
  which is what makes coming back a single click. Resuming waits for a health
  check before the live site returns, and rolls any scheduled work that came
  due during the pause forward to its next occurrence instead of firing a
  backlog. Nothing is destroyed: databases, credentials and configuration all
  survive the pause untouched.
- **Batch lead cleanup.** The admin leads view can now archive or permanently
  remove leads in bulk, acting on exactly the rows the current filters show,
  with a new "older than N days" filter for clearing out a stale pool. Both
  actions confirm before running; permanent deletion skips any lead already
  promoted to a real application.
- **A settable "searching since" date.** The month shown on the landing page
  can now be set by the owner instead of always being derived from the oldest
  application, so a deliberate break in the search doesn't read as a long
  stretch of inactivity.

## [1.0.7] - 2026-07-13

Job-search reliability and monitoring fidelity.

### Fixed

- The job-search index's slower responses could exceed the client's
  20-second timeout and be discarded as errors even though the query had
  actually succeeded — which both dropped fresh job leads and made the
  "Job search API" and "OneCLI gateway" nodes on the architecture page read
  as degraded. The timeout is now 45 seconds, matching how long that source
  can legitimately take, so those results land and the nodes reflect real
  health.

## [1.0.6] - 2026-07-13

Pipeline-accuracy hardening (continued) and monitoring fidelity.

### Fixed

- An application could be pushed to the **final** round when the automated
  mail reader saw a "next round" email that actually named an *earlier*
  interview round (for example, a system-design round) — which also generated
  a spurious final-round prep kit. The deterministic mail-to-board converter no
  longer guesses the target round from a generic "next round" signal; that
  placement is now owned by the agent, which reads the specific round named in
  the email and on the calendar. A genuine rejection or offer still closes the
  board as before.
- The "Job search API" node on the architecture page could show a false
  "Down" status or elevated error rate caused by dead or renamed job-board
  tokens returning 404s. A board that has moved or been renamed is now treated
  as skippable configuration drift rather than a request failure, and the
  node's health reflects only the job-search index it is labeled for.

## [1.0.5] - 2026-07-03

Interview-kit rendering fidelity.

### Fixed

- Interview-kit pages now render their formatting faithfully: numbered
  criteria count up correctly instead of every item showing "1.", emphasized
  text renders as italics rather than showing raw asterisks, and nested lists,
  tables, and links display properly. The kit's title block no longer surfaces
  as an empty "additional section," and an anonymization marker can no longer
  render as a broken chip.

### Changed

- The interview-kit Google Doc is now produced by native Markdown import, so
  the document a candidate opens preserves headings, tables, nested lists, and
  emphasis instead of a lossy approximation.

## [1.0.4] - 2026-06-27

Pipeline-accuracy hardening for the automated mail reader.

### Fixed

- A canceled or rescheduled interview (a calendar cancellation notice)
  could be mis-read as a forward step and wrongly advance an application
  to a later stage — generating a spurious interview-prep kit. Such
  notices are now treated as scheduling updates, not stage changes, and
  the pipeline board only moves a stage forward on a genuine signal (a
  recruiter rejection or offer still closes it).

### Added

- A control-center toggle to scope the mailbox-recovery scan to the inbox
  (default on), so a full re-sync no longer re-reads already-archived mail.

## [1.0.3] - 2026-06-26

Morning-automation reliability and agent-prompt hygiene.

### Fixed

- The daily morning automation could redundantly re-run a background sub-agent
  and leave a recurring job stuck — its container was being reclaimed while a
  sub-agent was still working. The container now stays alive for the full
  duration of a sub-agent task, so the morning routine completes in one clean
  pass.
- Repaired a vocabulary guard so internal terminology no longer surfaces in the
  public activity trace.

### Changed

- The daily automation now applies a detected pipeline change — advancing an
  application's stage and preparing its interview kit — at detection time rather
  than deferring it into the morning briefing. The briefing is now a lighter
  read-and-report step, so heavy background work can't delay the digest.
- Internal agent-instruction cleanup: removed developer-facing notes and
  configuration-dependent literals from the runtime agent persona (no behavior
  change).

## [1.0.2] - 2026-06-25

Transparent, owner-controlled visit attribution.

### Added

- **Named visit sources** in the control center — mint a labeled source (say, a
  LinkedIn link or a handed-out résumé), and get both a shareable link and a
  matching résumé PDF that attribute to it, so you can see which channel each
  visit came through. Sources can be copied, downloaded, and retired.

### Changed

- Attribution links are now transparent and self-describing — a readable
  `?from=<source>` label you can see right in the address bar, replacing the
  opaque short code, including the master résumé download. The visitor-privacy
  disclosure on the About and Privacy pages was updated to match.

## [1.0.1] - 2026-06-25

Owner control-center polish and a pipeline data-integrity fix.

### Added

- **Leads tab** in the control center — inspect the agent's running pool of
  discovered roles, see the deterministic match-score breakdown behind each, and
  triage them (re-score, change status, archive).
- A discovered role now links to its application automatically once one is
  submitted, so the pipeline and the lead pool stay in sync.

### Changed

- Control-center tables paginate and offer sortable columns, on a single shared
  table component across every tab.
- The control center's active tab lives in the URL — tabs are deep-linkable and
  the browser back/forward buttons move between them.

### Fixed

- The system-map detail panel honors the browser's reduced-motion setting for
  its fade-in.

## [1.0.0] - 2026-06-24

The first public release: an autonomous job-search agent with a live showcase portal.

### Added

- **Recruiter simulator** (`/watch`) — a visitor names a company and role and
  watches a sandboxed agent research it, tailor a résumé, and draft outreach end
  to end, with the run's real cost reported transparently.
- **Live pipeline & dashboard** — an anonymized application funnel, a real-time
  agent-activity trace, and AI-authored win-confidence, streaming over SSE.
- **System map** (`/architecture`) — the agent cast, their tools, and the data
  flow as an explorable diagram.
- **Owner operations** — a private, chat-driven control plane for the search:
  daily briefings, job scouting with killer-match alerting, pipeline curation,
  close detection, and per-interview prep kits.
- **Owner control center** (`/admin`) — a gated, tabbed operator cockpit over
  health, cost, the pipeline, contacts, and every operational knob.

### Security

- All outbound model traffic routes through a gateway; containers never receive
  raw credentials.
- The public site talks only to an edge proxy that authenticates to the backend
  with a scoped service token; the API origin has no public ingress.
- Company identities are redacted on every public surface; the first-party visit
  log is disclosed; there are no third-party trackers.
- Bot challenge, per-IP and global spend caps, and rate limiting guard the
  public money-spending paths.
