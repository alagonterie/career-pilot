/**
 * The canonical left→right pipeline stages, the single source of truth for the
 * board (PORTAL §5.4) and the compact strips that link to it (the /dashboard rail
 * + the marketing-home strip). §24.79 D2 replaced the two drifted per-component
 * literals (PipelineBoard's `COLUMNS`, PipelineCompact's `STAGES`) with this one.
 *
 * Each stage carries two display strings chosen by context:
 *  - `long`  — the destination /pipeline board, where the column has room for a
 *              descriptive name. Rendered through the headers' `uppercase` class
 *              (→ "TECH INTERVIEW") while the stored natural-case string keeps the
 *              `<section aria-label>` screen-reader name sensible.
 *  - `short` — the cramped compact strips (narrow cells) that link to the board.
 *
 * Naming boundary (§24.77 D3): the visitor-facing concept is the "pipeline"; the
 * `funnel`-prefixed `data-testid`s on the consuming components are the retained
 * internal component↔test contract and are unaffected by this display-only source.
 */
export interface PipelineStage {
  stage: string
  short: string
  long: string
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { stage: 'applied', short: 'APP', long: 'Applied' },
  { stage: 'screening', short: 'SCREEN', long: 'Screening' },
  { stage: 'tech', short: 'TECH', long: 'Tech interview' },
  { stage: 'final', short: 'FINAL', long: 'Final interview' },
  { stage: 'offer', short: 'OFFER', long: 'Offer' },
]

/** The set of stages shown as board columns / compact cells — everything else
 * (terminal `rejected`/`withdrawn`, `bookmarked`) is surfaced off-board. */
export const PIPELINE_STAGE_SET = new Set(PIPELINE_STAGES.map((s) => s.stage))

/**
 * The shared desktop lane height (§24.79 D3). Tablet (`sm`) keeps the original
 * fixed `16rem`; desktop (`lg`) scales with the viewport — floor 20rem so it never
 * drops below today's usefulness, the `calc` reserves the page chrome above the
 * board, cap 46rem so a very tall monitor doesn't turn one lane into the whole
 * page. The board AND its loading skeleton read this one constant so loading→loaded
 * never resizes (§24.36 Tier-2 / §24.62). Deterministic at the fixed Playwright
 * visual viewport → stable re-blessed baselines.
 */
export const PIPELINE_LANE_HEIGHT = 'sm:h-[16rem] lg:h-[clamp(20rem,calc(100vh-22rem),46rem)]'
