---
name: skill-library
description: Index of ECC skills and agents kept out of this repo on purpose (LIBRARY), and how to fetch one. Use when a task needs a pattern none of the installed skills cover — MCP client/server work, Playwright or Stagehand browser automation, SQLite schema migrations, API design, latency work, structured-text parsing — or when an installed ECC skill refers to an ECC script that is not present.
---

# ECC skill library

This repo carries a hand-picked subset of [ECC](https://github.com/affaan-m/ECC)
(release `v2.2.3`, commit `c05b2d6614f62f6db0047669aa4eefb223d478f9`, MIT — see
`.claude/ECC-LICENSE`) instead of the full plugin, which added ~45k tokens to
every session.

- **DAILY** — copied into `.claude/skills`, `.claude/agents`, `.claude/commands`.
  Loaded every session.
- **LIBRARY** — not copied. Still reachable: read it from the pinned release
  when a task needs it, and copy it in only if it turns into daily use.

## Fetching a LIBRARY item

Read it at the pinned commit rather than `main`, so nothing changes under you:

```
https://raw.githubusercontent.com/affaan-m/ECC/c05b2d6614f62f6db0047669aa4eefb223d478f9/skills/<name>/SKILL.md
https://raw.githubusercontent.com/affaan-m/ECC/c05b2d6614f62f6db0047669aa4eefb223d478f9/agents/<name>.md
```

Some skills have extra files beside `SKILL.md`; list the directory on GitHub at
that commit before copying one in.

## LIBRARY, grouped by trigger

| When the task involves | Skills / agents |
|---|---|
| The planned MCP client layer (Phase 5) | `mcp-server-patterns` |
| Browser layer (Stagehand / Playwright) | `e2e-testing`, `browser-qa`, agent `e2e-runner` |
| SQLite schema changes in `src/memory/db.ts` | `database-migrations` |
| REST / WebSocket protocol design | `api-design` |
| Voice latency measurement | `latency-critical-systems`, `benchmark-optimization-loop` |
| Normalising text before TTS | `regex-vs-llm-structured-text` |
| Retrieval quality for episodic memory | `iterative-retrieval` |
| Reaching for a dependency vs writing code | `search-first` |
| Recording a design decision | `architecture-decision-records` (this repo keeps decisions in `ARCHITECTURE.md`, not `docs/adr/`) |
| Python tests | `python-testing` assumes pytest; the desktop client uses `unittest` |
| Homelab networking (outside this repo) | `homelab-*` skills, agent `homelab-architect` |

Everything else in ECC (other languages and frameworks, healthcare, trading,
marketing, media) has no use in this repo.

## Notes on the installed copies

The DAILY files are unmodified upstream copies, so they can be refreshed by
copying again from a newer release. A few lines in them assume a full ECC
install:

- `tdd-workflow` step 0 runs `node scripts/setup-package-manager.js`. That
  script is not here. This repo uses npm: `npm test` (node:test via tsx) and
  `npm run typecheck`.
- `eval-harness` "Local Framework Utilities" refers to `scripts/eval-harness.js`,
  which is not here. The method applies; this repo's evals are
  `dev/scripts/*-verify.ts`.
- `save-session` / `resume-session` write to `~/.claude/session-data/`, which
  is lost when a cloud session's container is reclaimed. They persist on a
  local machine only.
- No ECC hooks are installed.
