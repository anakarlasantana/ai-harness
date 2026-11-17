---
name: dev-code-review-and-quality
description: 
---

# Code Review and Quality

Use this Skill **only** when reviewing a change before merge, reviewing another agent's output, or when a refactor/bug fix needs a quality pass.

## Review order
1. Correctness: behavior, edge cases, errors, tests.
2. Architecture: existing boundaries, dependencies, conventions.
3. Readability: naming, control flow, duplication, unnecessary abstraction.
4. Security: trust boundaries, authorization, validation, secrets, unsafe input.
5. Performance: obvious I/O, N+1, unnecessary work, rendering/network issues.

## Evidence policy
- Inspect only changed files plus the smallest surrounding context required.
- Prefer `git diff`/changed-file scope before broad repository exploration.
- Report findings with severity and `file:line`.
- Do not invent vulnerabilities or performance measurements. Mark unmeasured impact as potential.

## Output
Return: **Blockers**, **Important**, **Suggestions**, then a short verdict. Keep it compact.

For detailed heuristics/examples, read `DETAILS.md` only if the current review needs them.
