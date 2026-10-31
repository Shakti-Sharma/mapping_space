---
description: Do the next unticked task from TASKS.md with minimum tokens
agent: build
---
Open TASKS.md and pick the FIRST unticked task under "Backlog" (or task $ARGUMENTS if given).
Follow AGENTS.md strictly: read only that task's `files:`, small diffs, run `npm test` and `npm run build`,
tick the task, reply in ≤5 lines.
