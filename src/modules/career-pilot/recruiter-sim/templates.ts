/**
 * Recruiter-sim email templates (Sub-milestone 9.3b, STRATEGY.md §24.40).
 *
 * The deterministic backbone of the D2 split: each classification maps to a
 * fixed subject + an always-correct body + a Haiku prompt that enriches the body
 * into realistic recruiter/ATS prose. Pure — no I/O, no LLM. The runner uses the
 * deterministic body verbatim when Haiku is disabled or over the sim budget, so
 * the engine never hard-depends on the model.
 *
 * Everything here is fictional/generic (the project's no-real-identifiers rule).
 */
import type { EmailClassification } from '../pipeline-types.js';

export interface EmailContext {
  company: string;
  role: string;
}

export interface EmailContent {
  subject: string;
  deterministicBody: string;
  prosePrompt: string;
}

const SIGNOFF = 'Talent Team';

/** The pipeline stages the scenario walks (pre-terminal), in order. */
export const STAGE_CLASSIFICATIONS: EmailClassification[] = [
  'application_confirmation',
  'screen_invite',
  'onsite_invite',
  'next_round_update',
];

function prosePrompt(persona: string, facts: string): string {
  return [
    `You are writing one short ${persona} email to a job candidate. Rewrite the body below in a`,
    'natural, professional voice. Keep it under 120 words, no subject line, no placeholders to fill',
    '(use the facts as given), plain text only. Do not invent specifics beyond the facts.',
    '',
    `Facts: ${facts}`,
  ].join('\n');
}

/** Build the subject + deterministic body + prose prompt for a classification. */
export function buildEmailContent(classification: EmailClassification, ctx: EmailContext): EmailContent {
  const { company, role } = ctx;
  switch (classification) {
    case 'application_confirmation':
      return {
        subject: `We received your application — ${role}`,
        deterministicBody: `Thanks for applying to the ${role} role at ${company}. We've received your application and our team is reviewing it. We'll be in touch with next steps.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'automated applicant-tracking confirmation',
          `company=${company}, role=${role}, stage=application received`,
        ),
      };
    case 'screen_invite':
      return {
        subject: `Next step: intro call for the ${role} role`,
        deterministicBody: `Hi — we enjoyed your application for the ${role} position at ${company} and would like to set up a 30-minute intro call with a recruiter. Please reply with a few times that work for you this week.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'recruiter screen invitation',
          `company=${company}, role=${role}, stage=phone screen invite, asking for availability`,
        ),
      };
    case 'take_home_delivery':
      return {
        subject: `${company} — take-home exercise for the ${role} role`,
        deterministicBody: `As the next step for the ${role} role, we'd like you to complete a short take-home exercise. You'll have one week. The brief and submission link are attached to your candidate portal.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'automated take-home assignment notice',
          `company=${company}, role=${role}, stage=take-home exercise, one week to complete`,
        ),
      };
    case 'onsite_invite':
      return {
        subject: `Interview invitation — ${role} at ${company}`,
        deterministicBody: `Great news — we'd like to move you to an interview for the ${role} role. We've proposed a time on your calendar; please accept or let us know if another slot works better.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'recruiter interview invitation',
          `company=${company}, role=${role}, stage=onsite/virtual interview, calendar invite proposed`,
        ),
      };
    case 'next_round_update':
      return {
        subject: `Update on your ${role} interview`,
        deterministicBody: `Thanks for taking the time to interview for the ${role} role at ${company}. The team was impressed and would like to proceed to a final conversation. We'll follow up shortly with details.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'recruiter progress update',
          `company=${company}, role=${role}, stage=advancing to final round, positive`,
        ),
      };
    case 'offer':
      return {
        subject: `Your offer from ${company} — ${role}`,
        deterministicBody: `We're delighted to extend an offer for the ${role} role at ${company}. The full offer details are attached. We're excited about the prospect of you joining and are happy to answer any questions.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'recruiter offer',
          `company=${company}, role=${role}, stage=written offer extended, warm`,
        ),
      };
    case 'screen_rejection':
    case 'rejection':
      return {
        subject: `Update on your application — ${role}`,
        deterministicBody: `Thank you for your interest in the ${role} role at ${company} and for the time you invested. After careful consideration we've decided not to move forward at this time. We wish you the best in your search.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'polite rejection',
          `company=${company}, role=${role}, stage=not moving forward, courteous`,
        ),
      };
    case 'cold_recruiter_outreach':
      return {
        subject: `${role} opportunity at ${company}`,
        deterministicBody: `Hi — I came across your profile and think you could be a strong fit for a ${role} opening on our team at ${company}. Would you be open to a quick chat this week?\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'cold recruiter outreach',
          `company=${company}, role=${role}, stage=unsolicited sourcing, friendly`,
        ),
      };
    case 'reference_check':
      return {
        subject: `Reference request — ${role} at ${company}`,
        deterministicBody: `As we finalize your candidacy for the ${role} role, we'd like to collect a couple of professional references. Please reply with two contacts and the best way to reach them.\n\n— ${company} ${SIGNOFF}`,
        prosePrompt: prosePrompt(
          'reference-check request',
          `company=${company}, role=${role}, stage=collecting references`,
        ),
      };
    case 'noise':
    case 'unclassified':
    default:
      return buildNoiseContent();
  }
}

const NOISE_SUBJECTS = [
  'Your weekly engineering newsletter',
  'Reminder: update your account preferences',
  '5 talks you might have missed this month',
  'New courses in your area of interest',
];

/** A standalone, non-pipeline email — realism filler that tests classifier precision. */
export function buildNoiseContent(index = 0): EmailContent {
  const subject = NOISE_SUBJECTS[index % NOISE_SUBJECTS.length];
  return {
    subject,
    deterministicBody: `${subject}.\n\nThis is an automated digest. You're receiving it because you subscribed. Manage your preferences or unsubscribe at any time from the link in your account settings.`,
    prosePrompt: prosePrompt(
      'generic marketing newsletter (NOT job-related)',
      `subject=${subject}, this is noise — unrelated to any job application`,
    ),
  };
}
