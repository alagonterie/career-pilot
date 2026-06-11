/**
 * src/modules/portal/public-kit-view.ts — the /kit dossier read-model
 * (STRATEGY.md §24.65).
 *
 * `upsertPublicKitView(db, applicationId)` recomputes every kit row for one
 * application in `public_kit_view` from the private `interview_kits` truth,
 * applying the §24.65 per-section policy for the application's CURRENT
 * `public_state`:
 *
 *   public (revealed post-close) → every section renders; deterministic
 *     sanitize() still runs (Pass 1 PII + Pass 2 redaction of OTHER non-public
 *     companies a kit might mention).
 *   obfuscated (live) → 'safe' sections render through the full public path
 *     (sanitize + the Pass 3 belt, withhold-on-fail) and a defense-in-depth
 *     company scan; 'identifying' / 'gap' / 'unknown' sections are SEALED —
 *     the projection emits the section's existence, item count, and an honest
 *     caption, never its text.
 *
 * The seal is server-side by construction: withheld text never lands in
 * `public_kit_view`, so it can never reach the wire. No kit title and no
 * drive_url either — both carry the real company name.
 *
 * Best-effort discipline (same as upsertPublicFunnelView): never throws; call
 * AFTER the private write commits. Re-run on kit persist, kit archive, and
 * BOTH directions of an obfuscation-policy flip.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

import { parseKitSections, type ParsedKitSection } from './kit-sections.js';
import { sanitize, sanitizeForPublic } from './sanitizer.js';

export interface PublicKitSection {
  id: string;
  title: string;
  part: number;
  kind: 'content' | 'withheld';
  body?: string;
  item_count?: number;
  withheld_reason?: string;
}

interface KitSourceRow {
  application_id: string;
  round: string;
  interview_type: string;
  interview_at: string | null;
  status: string;
  markdown: string | null;
}

// Honest per-class seal captions (the full line the frontend renders under the
// redaction bars — copy lives server-side so the reason can't drift from the policy).
function sealCaption(section: ParsedKitSection): string {
  const n = section.itemCount;
  switch (section.id.replace(/-\d+$/, '')) {
    case 'question-themes':
      return `${n} question theme${n === 1 ? '' : 's'} · sealed while this process is live — they quote the job description`;
    case 'grounding':
      return `${n} grounding fact${n === 1 ? '' : 's'} · sealed while this process is live — they'd identify the company`;
    case 'recent-signal':
      return `${n} signal item${n === 1 ? '' : 's'} · sealed while this process is live — they'd identify the company`;
    case 'questions-to-ask':
      return `${n} insider question${n === 1 ? '' : 's'} · sealed while this process is live — answerable only inside this company`;
    case 'gap-notes':
      return `${n} gap note${n === 1 ? '' : 's'} · sealed while live — names what the candidate would be probed on`;
    default:
      return `${n} item${n === 1 ? '' : 's'} · sealed while this process is live (unrecognized section — sealed by default)`;
  }
}

/** Sealed projection of a section: existence + count + caption, never text. */
function sealed(section: ParsedKitSection, override?: { id: string; title: string }): PublicKitSection {
  return {
    id: override?.id ?? section.id,
    title: override?.title ?? section.title,
    part: section.part,
    kind: 'withheld',
    item_count: section.itemCount,
    withheld_reason: sealCaption(section),
  };
}

/**
 * mirrorFunnelEvent's defense-in-depth net, alias-aware (§24.65 Δ): did a
 * non-public real company name — OR any of its aliases — survive? The alias
 * leg is load-bearing: a kit naturally says "AMD" while the stored
 * company_name is "Advanced Micro Devices, Inc" (found live on dev during the
 * Track J backfill) — scanning the canonical name alone misses the form the
 * prose actually uses.
 */
function leaksNonPublicCompany(db: Database.Database, text: string): boolean {
  try {
    const nonPublic = db
      .prepare(
        `SELECT company_name, company_aliases FROM applications WHERE public_state != 'public' AND company_name != ''`,
      )
      .all() as { company_name: string; company_aliases: string | null }[];
    const lower = text.toLowerCase();
    for (const { company_name, company_aliases } of nonPublic) {
      if (lower.includes(company_name.toLowerCase())) return true;
      if (company_aliases) {
        try {
          const aliases = JSON.parse(company_aliases) as unknown;
          if (Array.isArray(aliases)) {
            for (const a of aliases) {
              if (typeof a === 'string' && a.length > 1 && lower.includes(a.toLowerCase())) return true;
            }
          }
        } catch {
          // Unparseable aliases column — the name check above still ran.
        }
      }
    }
    return false;
  } catch (err) {
    log.error('public-kit-view: defense-in-depth scan failed', { err });
    // Fail CLOSED here (unlike the operator-toggleable audit-row net): kit
    // sections are long-form prose — seal on doubt.
    return true;
  }
}

async function projectSections(
  db: Database.Database,
  applicationId: string,
  isPublic: boolean,
  markdown: string,
  obfuscatedLabel?: string,
): Promise<PublicKitSection[]> {
  const parsed = parseKitSections(markdown);
  const out: PublicKitSection[] = [];
  let sealedUnknowns = 0;

  for (const section of parsed) {
    if (isPublic) {
      // Revealed post-close: everything renders; deterministic floor still
      // applies (PII + other non-public companies). The app's own name is not
      // redacted (Pass 2 skips public apps) — that's the point of the reveal.
      out.push({
        id: section.id,
        title: section.title,
        part: section.part,
        kind: 'content',
        body: sanitize(section.body, { application_id: applicationId, db }),
        item_count: section.itemCount,
      });
      continue;
    }

    if (section.cls !== 'safe') {
      // identifying / gap / unknown → sealed. Unknown sections also hide their
      // authored heading AND the slug id derived from it — either could itself
      // identify (fail-safe; caught by the projection's no-leak invariant test).
      const override =
        section.cls === 'unknown' ? { id: `x-sealed-${++sealedUnknowns}`, title: 'Additional section' } : undefined;
      out.push(sealed(section, override));
      continue;
    }

    // Safe section on a live app: full public pipeline + the company-scan net.
    const { text, ok } = await sanitizeForPublic(section.body, {
      application_id: applicationId,
      db,
      obfuscatedLabel,
    });
    if (!ok || leaksNonPublicCompany(db, text)) {
      out.push({
        id: section.id,
        title: section.title,
        part: section.part,
        kind: 'withheld',
        item_count: section.itemCount,
        withheld_reason: `${section.itemCount} item${section.itemCount === 1 ? '' : 's'} · sealed — the sanitizer could not verify this section`,
      });
      continue;
    }
    out.push({
      id: section.id,
      title: section.title,
      part: section.part,
      kind: 'content',
      body: text,
      item_count: section.itemCount,
    });
  }
  return out;
}

/**
 * Recompute every `public_kit_view` row for one application. Best-effort:
 * never throws. Rows for rounds whose kit vanished are deleted; an application
 * that no longer exists clears all of its rows.
 */
export async function upsertPublicKitView(db: Database.Database, applicationId: string): Promise<void> {
  try {
    const app = db
      .prepare('SELECT public_state, obfuscated_label FROM applications WHERE id = ?')
      .get(applicationId) as { public_state: string | null; obfuscated_label: string | null } | undefined;

    if (!app) {
      db.prepare('DELETE FROM public_kit_view WHERE application_id = ?').run(applicationId);
      return;
    }
    const isPublic = app.public_state === 'public';

    const kits = db
      .prepare(
        `SELECT application_id, round, interview_type, interview_at, status, markdown
           FROM interview_kits
          WHERE application_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(applicationId) as KitSourceRow[];

    // Drop projection rows for rounds that no longer have a kit.
    const rounds = kits.map((k) => k.round);
    if (rounds.length === 0) {
      db.prepare('DELETE FROM public_kit_view WHERE application_id = ?').run(applicationId);
      return;
    }
    db.prepare(
      `DELETE FROM public_kit_view
        WHERE application_id = ?
          AND round NOT IN (${rounds.map(() => '?').join(',')})`,
    ).run(applicationId, ...rounds);

    for (const kit of kits) {
      // No captured markdown (pre-§24.65 kit, backfill pending/failed) →
      // metadata-only row; the page renders an honest "content not captured".
      const sections =
        kit.markdown && kit.markdown.trim().length > 0
          ? await projectSections(db, applicationId, isPublic, kit.markdown, app.obfuscated_label ?? undefined)
          : [];

      db.prepare(
        `INSERT INTO public_kit_view (
           application_id, round, interview_type, interview_at, status, sections_json, updated_at
         ) VALUES (
           @application_id, @round, @interview_type, @interview_at, @status, @sections_json, @updated_at
         )
         ON CONFLICT(application_id, round) DO UPDATE SET
           interview_type = excluded.interview_type,
           interview_at   = excluded.interview_at,
           status         = excluded.status,
           sections_json  = excluded.sections_json,
           updated_at     = excluded.updated_at`,
      ).run({
        application_id: kit.application_id,
        round: kit.round,
        interview_type: kit.interview_type,
        interview_at: kit.interview_at,
        status: kit.status,
        sections_json: JSON.stringify(sections),
        updated_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    log.error('upsertPublicKitView failed', { applicationId, err });
  }
}
