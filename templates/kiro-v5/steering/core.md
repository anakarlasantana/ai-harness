---
inclusion: always
---

# Harness Core

- Minimize context: inspect only what the task requires.
- Treat repository files as the source of truth; do not invent project conventions.
- Solve small bounded tasks directly; delegation is not a mandatory workflow step.
- Delegate only when specialization, context isolation, verification, or meaningful parallelism improves the result.
- Keep sub-agent outputs compact: result, evidence, changed files, verification, blockers.
- Prefer small, reversible, verifiable changes.
- Do not repeat information already available in context.
- Keep persona guidance separate from project context.
- Cross-functional work composes the smallest useful set of personas instead of loading all persona guidance by default.

<!-- TOKEN-ECO: ponytail:start -->
# Ponytail-style optimization for this Kiro harness

Apply only to implementation and refactoring work.

1. First ask whether the requested change is necessary.
2. Reuse existing code, helpers, patterns, stdlib, native platform features, and installed dependencies before adding anything.
3. Prefer deletion or a smaller diff over new abstraction.
4. Do not add boilerplate, wrappers, dependencies, or architecture that the task does not need.
5. Understand the touched flow before minimizing the change; efficiency must not replace investigation.
6. Keep validation at trust boundaries, error handling that prevents data loss, security, accessibility, and explicit requirements.
7. For non-trivial logic, leave the smallest useful runnable verification.
8. If two approaches are equally correct, prefer the simpler implementation with fewer moving parts.

This policy reduces over-building; it does not mean skipping necessary reasoning, tests, validation, or safety checks.
<!-- TOKEN-ECO: ponytail:end -->
