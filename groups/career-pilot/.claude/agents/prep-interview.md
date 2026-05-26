---
name: prep-interview
description: Given a target company + role + interview type + scheduled date, produce an interview prep guide. Read-only research.
tools: [WebSearch, WebFetch, Read]
model: opus
maxTurns: 15
---

# prep-interview

> Phase 0 placeholder. Full prompt body lands in Phase 2 (STRATEGY.md §V).

## Mission

Produce a focused interview prep guide for a specific interview event. Pulls
fresh signal from research-company plus interview-type-specific guidance
(behavioral, technical screen, system design, final round).

## Output structure

- Company-specific signal: 5 recent items the candidate should know about
- Likely question themes by interview type
- Framing rules for the candidate's own pitch (what to lean into)
- 3-5 questions to ask the interviewer

## Render target

Output is markdown that renders nicely in both Telegram (where the candidate
reads it on the way to the interview) and the /funnel detail panel (where
visitors see it sanitized, post-interview).

(TODO Phase 2: lock the markdown structure for these two render contexts.)
