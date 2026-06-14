---
description: Create a spec file and feature branch for the next Trip Expense Splitter build-plan step
argument-hint: "<step number> <feature name> — e.g. 5 isolate math, or 13 join wizard"
allowed-tools: Read, Write, Glob, Bash(git:*)
---
You are a senior developer spinning up a new feature for **Trip Expense Splitter**. Always follow the rules and the Implementation Roadmap in `CLAUDE.md`. The app stack is **React Native (Expo Router) + FastAPI (Python) + MongoDB (Motor AsyncIOMotorClient)**.

User input: $ARGUMENTS

## Step 1 — Check working directory is clean
Run `git status` and check for uncommitted, unstaged, or untracked files. If any exist, stop immediately and tell the user to commit or stash changes before proceeding. DO NOT CONTINUE until the working directory is clean.

## Step 2 — Parse the arguments
From $ARGUMENTS extract:
1. `step_number` — zero-padded to 2 digits: 2 → 02, 11 → 11
2. `feature_title` — human readable title in Title Case
   - Example: "Isolate Mathematical Layer" or "Interactive Join Wizard"
3. `feature_slug` — git and file safe slug
   - Lowercase, kebab-case
   - Only a-z, 0-9 and -
   - Maximum 40 characters
   - Example: isolate-math, interactive-join-wizard
4. `branch_name` — format: `feature/<feature_slug>`
   - Example: `feature/isolate-math`
If you cannot infer these from $ARGUMENTS, ask the user to clarify before proceeding.

## Step 3 — Check branch name is not taken
Run `git branch` to list existing branches.
If `branch_name` is already taken, append a number:
`feature/isolate-math-01`, `feature/isolate-math-02`, etc.

## Step 4 — Switch to main and pull latest
Run:
git checkout main
git pull origin main

## Step 5 — Create and switch to the feature branch
Run:
git checkout -b <branch_name>

## Step 6 — Research the codebase
Read/scan these before writing the spec (use Glob; some directories may not exist yet this early in the refactor, which is fine):
- `CLAUDE.md` — the Implementation Roadmap, the splitting engine math, and system rules.
- `backend/models/`, `backend/routes/`, `backend/services/` — existing FastAPI structure and Pydantic models.
- `frontend/app/`, `frontend/src/` — current Expo app structure, context providers, and API wrappers.
- All files in `plan/` — avoid duplicating an existing spec.

Confirm in the `CLAUDE.md` **Implementation Roadmap** that the requested step's checkbox is still `- [ ]` (not done). If it is already `- [x]`, warn the user and stop.

## Step 7 — Write the spec
Generate a spec document with this exact structure:

---
# Spec: <feature_title>  (Step <step_number>)

## Overview
One paragraph describing what this feature does and why it exists at this point in the Trip Expense Splitter Roadmap (reference the matching step in `CLAUDE.md`).

## Depends on
Which previous Roadmap steps must be complete before this one.

## Data Model Changes (MongoDB/Pydantic)
New/changed Pydantic validation models, MongoDB document structures, or indexes. Remember: documents use `id` as UUID strings, NOT Mongo ObjectIds. If none: state "No data model changes".

## Backend API & Services (FastAPI)
New or changed FastAPI routes, dependencies, or service functions (e.g., `calculator.py`). Detail inputs/outputs, HTTP methods, and required RBAC (Admin vs Member). If none: state "No backend changes".

## App Screens & UI (Expo React Native)
- **Create:** new Expo Router screens with their path under `frontend/app/`
- **Modify:** existing screens/widgets under `frontend/app/` or `frontend/src/`

## State & API Integration
Changes to `frontend/src/api.ts`, Context wrappers (`AuthContext`, `ThemeContext`), or local `AsyncStorage` caching. If none: state so.

## Files to change
Every existing file that will be modified.

## Files to create
Every new file that will be created.

## New Dependencies
Any new Python (`requirements.txt`) or frontend (`package.json`) dependencies. If none: state "No new dependencies".

## Rules for Implementation
Specific constraints the implementer must follow. Always include:
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of `CLAUDE.md`.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact.
- Enforce Role-Based Access Control (RBAC) on the backend before executing destructive edits/deletes.
- Follow the frontend design system tokens; support dynamic light/dark mode via `ThemeContext`.
- Keep changes strictly scoped to this step; do not refactor unrelated code.

## Definition of Done
A specific, testable checklist. Each item must be something verifiable by running the Expo app or backend API. It MUST include running `pytest` for backend coverage of the new logic.
---

## Step 8 — Save the spec
Save the plan with the spec number inside the plan folder: `specs/<step_number>-<feature_slug>.md`
*(Create the `specs/` directory if it does not exist).*

## Step 9 — Report to the user
Print a short summary in this exact format:
```
Branch:    <branch_name>
Spec file: specs/<step_number>-<feature_slug>.md
Title:     <feature_title>
```
Then tell the user:
"Review the spec at `specs/<step_number>-<feature_slug>.md`, then enter Plan
Mode (cycle with Shift+Tab) to begin implementation."

Do not print the full spec in chat unless explicitly asked.