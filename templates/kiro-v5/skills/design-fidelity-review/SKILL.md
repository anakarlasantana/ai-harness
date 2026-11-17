---
name: design-fidelity-review
description: Review whether an implemented UI matches its design prototype (Figma via MCP or screenshot). Use before shipping UI to catch layout, token, spacing, typography, state and accessibility deviations.
---

# Design Fidelity Review

## Overview

Verify that the built UI faithfully matches the design. Report concrete, actionable mismatches only.

## Get both references

1. **Design**: Figma MCP (`get_screenshot`, `get_design_context`, `get_variable_defs`) when available; otherwise a screenshot/export.
2. **Implementation**: relevant source files and/or a screenshot of the running app.

## Checklist

- **Layout**: grid, alignment, regions, responsive behavior vs breakpoints.
- **Spacing**: padding/margins match the spacing token scale.
- **Typography**: sizes, weights, line-height, hierarchy.
- **Color**: matches tokens; contrast meets WCAG AA.
- **Components/states**: hover, active, disabled, error, loading, empty present and correct.
- **Accessibility**: semantics, labels, focus order, keyboard navigation.

## Output

Each finding: **Critical** / **Major** / **Minor**, with `file:line` (code) or node reference (design). Finish with a go/no-go for design fidelity.
