---
name: design-system-adherence
description: Ensure UI implementation uses the application's design system (tokens, components, spacing scale, typography) instead of ad-hoc values. Use when implementing or reviewing UI for visual consistency.
---

# Design System Adherence

## Principle

Production UI reuses the app's design system. Do not hardcode values that exist as tokens, and do not reinvent components that already exist.

## Rules

- Use **design tokens** for colors, spacing, radius, typography, shadows. Reference the token, never the raw value.
- Reuse existing **components** and their variants before building new ones.
- Follow the **spacing scale** (e.g. 4/8/16/24) — no arbitrary pixel values.
- Respect **typography scale** and hierarchy.
- If a required token/component is missing, flag it explicitly and propose the minimal addition (Ponytail: smallest reversible change).

## Review questions

- Any raw hex colors or magic numbers that should be tokens?
- Any duplicated component that should reuse an existing one?
- Does spacing follow the scale?
- Are all interactive states (hover/active/disabled/focus) implemented?
