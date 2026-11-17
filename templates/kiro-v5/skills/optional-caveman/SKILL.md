---
name: optional-caveman
# Keep the description narrow so Kiro does not activate this for every task.
description: >
  Compact-response mode for token-sensitive requests. Use when the user asks for brevity,
  fewer tokens, concise answers, or caveman mode. Reduce explanatory prose and repetition while
  preserving technical accuracy, code, commands, errors, paths, constraints, and required steps.
---

# Compact Response Mode

When active:

- Answer directly; remove greetings, filler, repeated context, and unnecessary explanations.
- Prefer bullets, short sections, and compact tables when they improve scanning.
- Do not compress away requirements, caveats, validation, security, error handling, or important trade-offs.
- Preserve code, commands, paths, identifiers, URLs, errors, and exact technical syntax.
- Do not rewrite code into pseudo-code merely to be shorter.
- If the task requires a detailed plan or explanation, keep the necessary detail and remove only repetition.
- Stay concise until the user asks for normal/detailed mode.

This Skill changes response verbosity. It is not a context-pruning mechanism and does not reduce the size of files/tools/history already sent by Kiro.
