---
name: context
description: Load full project context (CLAUDE.md + memory/ files) before working on a task. Use at the start of any non-trivial task or new session.
---

# Project context loader

Run through these steps, in order, before starting any work:

1. Read `CLAUDE.md` at the repo root for dev commands and the high-level architecture summary.

2. Load these memory files explicitly:
   @memory/ARCHITECTURE.md
   @memory/PRD.md

3. List the `memory/` directory and read any other files present (ignore `.gitkeep`), so files
   added after this skill was written are picked up automatically.

4. If an argument was passed (`$ARGUMENTS`), treat it as the area/task to focus on. Call out which
   parts of the architecture (backend section, data model, frontend route, etc.) are most relevant
   to that area before moving on.

5. Produce a short briefing covering:
   - What the app is (1-2 sentences).
   - Current architecture in 3-5 bullets (backend, data model, frontend, AI/integrations — whatever
     is most load-bearing).
   - Anything notably in-progress, flagged as tech debt, or a known issue (from §7 of
     ARCHITECTURE.md or elsewhere in memory/).
   - Then state you're ready and ask what to work on — unless `$ARGUMENTS` already specifies the
     task, in which case confirm you're oriented and proceed.

6. Never print secret values. If a memory file contains credentials or API keys, just note that
   they exist (e.g. "test credentials are documented in memory/test_credentials.md") without
   echoing the values.
