---
name: shared-using-agent-skills
description: 
---

# Using Agent Skills

Skills are specialized capabilities. Use the most specific Skill that matches the current task.

## Token-efficient policy
- Do not activate unrelated Skills.
- Prefer one primary Skill; add another only when its behavior is genuinely required.
- Load supporting references only when the primary Skill says they are needed.
- Do not duplicate a reference into a prompt; point the agent to the file.
- If the task is small, skip orchestration overhead.

The Kiro harness should rely on Skill discovery/activation rather than a startup hook that injects a meta-Skill.

For the former detailed guidance, read `DETAILS.md` only when maintaining this harness.
