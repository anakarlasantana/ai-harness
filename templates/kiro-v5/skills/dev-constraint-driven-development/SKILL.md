---
name: dev-constraint-driven-development
description: 
---

# Constraint-Driven Development

Use when the project lacks a written quality bar, the user asks to define standards/thresholds, or autonomous work needs explicit gates.

## Goal
Create or update a durable `CONSTRAINTS.md` with measurable project-specific rules. Prefer the smallest useful set of constraints.

## Process
1. Inspect existing project conventions and CI first.
2. Ask only for decisions that materially affect the quality bar; otherwise propose conservative defaults.
3. Record thresholds and commands in `CONSTRAINTS.md`.
4. Ensure CI or verification commands can enforce them.
5. Never weaken a constraint merely to make a task green; require an explicit decision.

## Guardrails
Watch for skipped/deleted tests, weakened thresholds, new suppressions, stubs, and disabled checks.

For the detailed rationale and examples, read `DETAILS.md` only when needed.
