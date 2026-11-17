---
name: dev-performance-optimization
description: 
---

# Performance Optimization

Use only for performance-focused work. Optimize from evidence, not intuition.

## Workflow
1. Define the user/system-visible bottleneck.
2. Measure or establish a credible baseline when measurement is possible.
3. Find the highest-impact cause.
4. Make the smallest change that targets that cause.
5. Re-measure or verify with the appropriate test.
6. Avoid speculative micro-optimizations.

## Common checks
- Backend: query count, N+1, serialization, caching, CPU, memory, I/O.
- Frontend: bundle size, rendering, network waterfalls, unnecessary state/reactivity, images.
- Database: indexes, query plans, pagination, over-fetching.

Never present a potential impact as a measured result.

Read `DETAILS.md` only for the detailed checklists/frameworks required by the task.
