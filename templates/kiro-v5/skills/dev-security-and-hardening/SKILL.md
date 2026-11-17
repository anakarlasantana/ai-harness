---
name: dev-security-and-hardening
description: 
---

# Security and Hardening

Use only for security review, threat analysis, hardening, authentication/authorization, secrets, validation, or security-sensitive implementation.

## Priority
1. Authentication and authorization / tenant isolation
2. Injection and untrusted input
3. Secrets and sensitive data
4. Session/token handling and rate limiting
5. File/URL/command boundaries
6. Dependency and configuration risks

## Method
- Identify trust boundaries and attacker-controlled inputs.
- Inspect the smallest relevant code/config scope.
- Prefer concrete exploit paths and practical mitigations.
- Never claim a vulnerability without evidence.

## Output
Findings: severity → location → risk → remediation. Separate confirmed issues from hardening suggestions.

Read `DETAILS.md` only when the task needs the full threat/checklist coverage.
