# Spec: Ubiquitous Global Session Drop — Clean Logout UI (Step 19)

## Overview
Step 19 of the Trip Expense Splitter Roadmap ("Ubiquitous Global Session Drop") makes the shared
`LogoutButton` a first-class, *universal* element anchored to the top-right of every authenticated,
persistent screen's header via Expo Router `_layout.tsx` `screenOptions`. The plumbing is already
partially in place (the root `Stack` and the `(tabs)` navigator both set `headerRight`), but the
current state is **inconsistent and unclean**, which is exactly what this step ("logout_cleanUI_logic")
must fix:

1. **Modals leak a logout control.** Every modal-presentation screen (`add-member`, `edit-member`,
   `manage-member`, `add-expense`, `edit-expense`, `trip/[id]/edit`, `create-trip`, `join-trip`)
   inherits the root `Stack`'s `headerRight`, so a destructive "Sign out" icon sits in the top-right
   of half-completed forms — a UX footgun, since one mis-tap drops the session mid-edit.
2. **The Profile screen is redundant.** It renders an inline "Sign out" row *and* the header logout
   icon, presenting two paths to the same action on one screen.
3. **The logout flow is duplicated.** The `Alert.alert('Sign out?')` → `signOut()` →
   `router.replace('/(auth)/login')` sequence is copy-pasted in both `frontend/src/LogoutButton.tsx`
   and `frontend/app/(tabs)/profile.tsx`, so the confirm copy, the redirect target, and the
   destructive styling can drift apart.

This step consolidates the logout flow into a **single source of truth**, guarantees the header logout
icon appears on every persistent authenticated screen, and deliberately **suppresses** it on transient
modal screens (which instead get a consistent Close control), producing the clean, predictable session
drop the roadmap calls for. No backend, data-model, or split-engine behavior changes.

## Depends on
- **Step 18 — Layout UI Audit & Standardization** (`- [x]`): typography scale, spacing grid, and color
  tokens (`SPACING`, `RADIUS`, `colors`) the header/button must consume.
- **Existing session infrastructure** (already shipped): `AuthContext.signOut()` and the `(auth)/login`
  route are the targets the consolidated flow drives. This step does **not** change either.

## Data Model Changes (MongoDB/Pydantic)
No data model changes.

## Backend API & Services (FastAPI)
No backend changes. This is a frontend-only navigation/UI consolidation step. Logout is a client-side
token drop (`setToken(null)` in `AuthContext`); there is no server session to invalidate.

## App Screens & UI (Expo React Native)

### Create
- `frontend/src/useLogout.ts` — a tiny shared hook exposing `confirmAndSignOut()` that owns the *single*
  logout flow: show the `Alert.alert('Sign out?', …)` confirm, call `signOut()` from `AuthContext`,
  then `router.replace('/(auth)/login')`. Both the header button and the Profile row call this so the
  confirm copy, redirect target, and behavior never drift. (Alternative acceptable implementation: keep
  the flow inside `LogoutButton.tsx` and export a `confirmAndSignOut` helper — but a hook is cleaner for
  the Profile row's reuse.)
- `frontend/src/HeaderCloseButton.tsx` *(only if needed — see Rules)* — a themed top-left Close control
  (`Ionicons name="close"` or `chevron-back`) calling `router.back()`, used by modal screens that
  replace the (now-removed) logout icon so the modal stays dismissable on Android.

### Modify
- `frontend/app/_layout.tsx` (root `Stack`):
  - Keep `headerRight = user ? () => <LogoutButton /> : undefined` for **persistent** authenticated
    screens (`trip/[id]/index`, `trip/[id]/settle-up`, `trip/[id]/category/[name]`).
  - For every **modal** screen (`presentation: 'modal'`: `add-member`, `edit-member`, `manage-member`,
    `add-expense`, `edit-expense`, `trip/[id]/edit`, `create-trip`, `join-trip`) explicitly override
    `headerRight: undefined` so the logout icon does **not** appear mid-form, and ensure each modal is
    dismissable (native swipe-down on iOS; a `HeaderCloseButton`/existing in-form Cancel on Android).
- `frontend/app/(tabs)/_layout.tsx`: keep the universal `headerRight: () => <LogoutButton />` on the
  tab navigator (dashboard, trips, add, reports, profile). No change to behavior, but the button must
  consume the consolidated component.
- `frontend/src/LogoutButton.tsx`: refactor to call `useLogout().confirmAndSignOut` instead of
  re-implementing the `Alert`/`signOut`/`router.replace` flow inline. Keep `testID="header-logout"`,
  the themed `colors.textMain` icon, and the existing touch target padding.
- `frontend/app/(tabs)/profile.tsx`: remove the duplicated inline `handleSignOut` (the `Alert` +
  `signOut` + `router.replace`). **Design decision (confirm on review):** the inline labeled
  "Sign out" row (`testID="profile-logout"`) is kept for discoverability/accessibility but is rewired
  to call `useLogout().confirmAndSignOut`, so Profile has the labeled row + the header icon backed by
  one flow. (If the reviewer prefers a stricter "header only" cleanup, delete the row entirely and rely
  on the header icon.)
- `frontend/app/(auth)/_layout.tsx`: **verify only** — must continue to show **no** logout control
  (unauthenticated screens: login, register, pin-login, forgot, reset). No change expected.

## State & API Integration
- No changes to `frontend/src/api.ts`.
- No changes to `AuthContext`'s public surface — reuse the existing `signOut(clearSavedEmail?)`. The
  consolidated flow calls `signOut()` with the default (`clearSavedEmail = false`) so the last-used
  email is preserved for quick PIN login, matching today's behavior.
- No changes to `ThemeContext`; the button/close controls read `colors` from `useTheme()`.
- No new `AsyncStorage` keys.

## Files to change
- `frontend/app/_layout.tsx`
- `frontend/app/(tabs)/_layout.tsx`
- `frontend/src/LogoutButton.tsx`
- `frontend/app/(tabs)/profile.tsx`
- `frontend/app/(auth)/_layout.tsx` *(verification only; likely no edit)*
- `CLAUDE.md` *(flip Step 19 `- [ ]` → `- [x]` after the work is committed)*

## Files to create
- `frontend/src/useLogout.ts`
- `frontend/src/HeaderCloseButton.tsx` *(only if a modal needs an explicit Android-dismissable control)*

## New Dependencies
No new dependencies. Uses the already-installed `expo-router`, `@expo/vector-icons`, and React Native
`Alert`.

## Rules for Implementation
- **Single source of truth.** After this step, the `Alert('Sign out?')` → `signOut()` →
  `router.replace('/(auth)/login')` sequence must exist in exactly one place (`useLogout.ts`). No screen
  may re-implement it inline. Reviewers should be able to `grep` for `router.replace('/(auth)/login')`
  and find it only in the shared hook.
- **No logout on modals.** Modal-presentation screens must not render the logout icon. Removing it must
  not make a modal undismissable — verify swipe-down (iOS) and provide/keep an explicit Close or Cancel
  control for Android.
- **No logout on auth screens.** The `(auth)` group must never show a session-drop control.
- **Preserve saved email.** Logout must call `signOut()` without `clearSavedEmail`, keeping
  `last_login_email` so PIN quick-login still works.
- **Keep test hooks stable.** Preserve `testID="header-logout"` and `testID="profile-logout"` so any
  existing/automation selectors keep resolving.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, `colors`) and support dynamic
  light/dark mode via `ThemeContext` for every new control (button + close).
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md` — untouched by this step; do not alter any expense/split code.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact — untouched here.
- Enforce RBAC on the backend before destructive edits/deletes — untouched here; no backend edits.
- Keep changes strictly scoped to this step; do not refactor unrelated screens, navigation, or styles.

## Definition of Done
A reviewer can verify every item below by running the Expo app and the backend test suite.

- [ ] **Persistent screens show logout.** On dashboard, trips, add, reports, profile, `trip/[id]`,
      settle-up, and category screens, the top-right header shows the `log-out-outline` icon; tapping it
      shows the "Sign out?" confirm, and confirming returns to `(auth)/login` with the session cleared.
- [ ] **Modals show NO logout.** Opening Add Member, Edit Member, Manage Member, Add Transaction, Edit
      Transaction, Edit Trip, Create Trip, and Join Trip shows **no** logout icon in the header, and each
      modal is still dismissable (swipe-down / Close / Cancel).
- [ ] **Auth screens show NO logout.** login, register, pin-login, forgot, and reset render no logout
      control.
- [ ] **No duplicate flow.** `grep` confirms the `Alert('Sign out?')` + `router.replace('/(auth)/login')`
      sequence exists only in `frontend/src/useLogout.ts`; `LogoutButton.tsx` and `profile.tsx` both call
      the shared hook.
- [ ] **Profile is consistent.** The Profile screen's "Sign out" affordance and the header icon both run
      the same shared flow (no divergent confirm copy or redirect).
- [ ] **Saved email preserved.** After logout, the login screen still pre-fills / offers the last-used
      email for PIN quick-login.
- [ ] **Theming.** Logout (and any Close) control renders correctly in both light and dark mode using
      `ThemeContext` tokens.
- [ ] **`yarn lint` passes** in `frontend/` with no new warnings/errors from the changed files.
- [ ] **`pytest` passes** in `backend/` (run from `backend/`): the full suite stays green, confirming
      this frontend-only change introduces no backend regression. (No new backend logic is added in this
      step, so there is no new backend test to write; the gate is "suite remains green.")
- [ ] **Roadmap updated.** `CLAUDE.md` Step 19 is flipped from `- [ ]` to `- [x]` in the same commit set
      once the above are verified.
