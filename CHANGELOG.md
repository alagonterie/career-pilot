# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the **product** version line. It is independent of the vendored NanoClaw
fork version recorded in `package.json` — the two are never conflated.

<!-- On cutover: move the accumulated Unreleased items into a new version
     section, and set [1.0.0]'s date to the actual release date before tagging. -->

## [Unreleased]

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
