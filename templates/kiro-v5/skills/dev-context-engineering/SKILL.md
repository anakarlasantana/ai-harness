---
name: dev-context-engineering
description: 
---

# Context Engineering

Use when the task is blocked by context size, poor retrieval, repeated file reading, or when optimizing the agent harness itself.

## Rules
- Start from the user's intent and identify the minimum evidence required.
- Prefer changed files, symbols, exact search terms, and small ranges.
- Do not load large references unless the task needs them.
- Summarize discovered context before handing it to another agent.
- Keep durable rules in Steering/Skills; keep project facts in project files.
- Remove duplicate instructions before adding new ones.

For deeper retrieval strategies, read `DETAILS.md` only when needed.
