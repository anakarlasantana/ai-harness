---
name: lgpd-technical-audit
description: Execute technical LGPD/privacy audits of an existing application, mapping personal-data flows, security, retention, rights, third parties, AI/LLM, multi-tenancy and evidence. Use only when an LGPD technical audit is explicitly requested.
---

# LGPD Technical Audit

Use only for a dedicated technical audit. Do not invoke for ordinary implementation work.

- Audit the real implementation, not the intended architecture.
- Never invent evidence, line numbers, controls, legal bases or requirements.
- If implementation cannot be located, classify it as `NÃO EVIDENCIADO`.
- Distinguish technical findings from legal/business/governance decisions.
- During the first audit stage, do not modify code, database, configuration or infrastructure; do not install dependencies or execute destructive commands.
- Preserve exact evidence and compare documentation with implementation.
- This is a technical audit and does not replace legal, DPO, compliance, contractual or regulatory review.

Conformity: `CONFORME`, `PARCIALMENTE CONFORME`, `NÃO CONFORME`, `NÃO EVIDENCIADO`, `NÃO APLICÁVEL`.
Severity: `CRÍTICO`, `ALTO`, `MÉDIO`, `BAIXO`.
Urgency: `P0`, `P1`, `P2`, `P3`, `P4`.
Legal interpretation: `REQUER VALIDAÇÃO JURÍDICA`.

Follow `AUDIT-PROTOCOL.md` and produce `LGPD-AUDIT-REPORT.md` with its mandatory structure, evidence, executive matrix, remediation plan, roadmap, quick wins, governance dependencies, RIPD considerations, maturity assessment and limitations.
