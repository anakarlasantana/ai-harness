---
name: design-prototype-analysis
description: Analyze a design prototype (Figma via MCP, or a screenshot/export) and derive an implementable UI specification. Use when building UI from a design, when given a Figma link, or when the task references a prototype.
---

# Design Prototype Analysis

## Overview

Turn a prototype into an implementable specification. The goal is that an engineer can build the screen without re-opening the design.

## Input sources (in priority order)

1. **Figma MCP** (preferred) — when a Figma URL is provided and the MCP is available:
   - `get_design_context` — structure, layout, component hierarchy for a node.
   - `get_metadata` — page/frame tree and node IDs.
   - `get_variable_defs` — design tokens (color, spacing, type).
   - `get_screenshot` — visual reference.
2. **Screenshot / export** — a provided image (path or attachment). Treat as a visual reference; state anything you cannot determine as an assumption.

## What to extract

- **Frames/screens** and their role in the flow.
- **Layout**: regions, grid, alignment, spacing scale, responsive breakpoints.
- **Components**: reusable pieces + variants + states (default/hover/active/disabled/error/loading/empty).
- **Tokens**: colors, spacing, typography — map to the app's design system; flag gaps.
- **Content & data**: labels, inputs, validation, empty/loading/error states.
- **Accessibility**: semantic structure, labels, focus order, contrast (WCAG AA).

## Output

A concise spec (not code): screens, layout, components+states, tokens, interactions, a11y, and open questions. Be explicit about assumptions when using a screenshot instead of the MCP.
