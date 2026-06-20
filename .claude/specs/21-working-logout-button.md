# Spec: Working Logout Button  (Step 21)

## Overview
Step 19 ("Ubiquitous Global Session Drop") anchored a shared `LogoutButton` into the header and
consolidated the flow into `frontend/src/useLogout.ts`. In practice the logout button is **buggy**, which
is what this step ("working_logout_button", session `logout_bugs`) fixes. Three concrete defects exist:

1. **The confirm dialog is broken on web and unthemed everywhere.** `useLogout` calls
   `Alert.alert('Sign out?', '', [...])` with custom buttons. On React Native Web `Alert.alert` does
   **not** render multiple buttons (it degrades to a single-OK `window.alert` or a no-op), so the
   destructive "Sign out" action is unreachable — the button literally does nothing on web. Even on
   native, `Alert` is OS-styled and ignores the app's light/dark `ThemeContext`. The repo already ships
   a cross-platform, theme-aware `frontend/src/ConfirmModal.tsx` built for exactly this case (its own doc
   comment contrasts it with the native `Alert`), but logout never uses it.
2. **The authenticated back-stack leaks after logout.** `confirmAndSignOut` does
   `await signOut()` (which sets `user = null`) then `router.replace('/(auth)/login')`. `replace` only
   swaps the *top* route. If the user drilled `dashboard → trip/[id] → settle-up`, the authenticated
   screens remain underneath; after replace, an Android hardware-back returns to a now-unauthenticated
   screen that fires `401`s against a cleared token. Logout must fully tear down the authenticated stack.
3. **No declarative auth guard.** Logout navigation is purely imperative, living in one Alert callback.
   If `user` ever flips to `null` by any other path (token expiry caught in `AuthContext.refresh`, a
   future programmatic `signOut`), nothing redirects the user out of the authenticated tree. Auth-driven
   navigation should be declarative so the session drop is reliable regardless of trigger.

This step makes the logout button **actually work on every platform**: it routes the confirm through the
themed `ConfirmModal`, fully resets navigation on sign-out, and adds a declarative redirect guard — while
preserving step 19's single-source-of-truth rule and the saved-email/PIN quick-login behavior. No
backend, data-model, or split-engine behavior changes.

## Depends on
- **Step 18 — Layout UI Audit & Standardization** (`- [x]`): `SPACING`, `RADIUS`, and `colors` tokens
  (incl. `colors.owing` for destructive styling) the confirm modal consumes.
- **Step 19 — Ubiquitous Global Session Drop** (`- [x]`): established the shared `LogoutButton`,
  `useLogout`, the root/tab `headerRight` wiring, and the "exactly one logout flow" rule this step keeps.
- **Existing session infrastructure** (already shipped): `AuthContext.signOut(clearSavedEmail?)`, the
  `(auth)/login` route, and the `ConfirmModal` component. This step does not change `AuthContext`'s public
  surface or the `ConfirmModal` props contract (only an additive variant — see below).

## Data Model Changes (MongoDB/Pydantic)
No data model changes. Logout is a client-side token drop (`setToken(null)` in `AuthContext`); there is
no server session to invalidate.

## Backend API & Services (FastAPI)
No backend changes. This is a frontend-only navigation/UI bug fix.

## App Screens & UI (Expo React Native)

### Create
- `frontend/src/LogoutProvider.tsx` — a small context provider that owns the **one** logout flow. It:
  - Holds the confirm modal's `visible` state.
  - Renders exactly one global `<ConfirmModal>` (so the themed confirm works on web/native; a hook alone
    cannot mount a Modal — this is why the flow moves into a provider).
  - Exposes `confirmAndSignOut()` (opens the modal) via context. The modal's destructive action calls
    `await signOut()`, then resets navigation (`router.dismissAll?.()` guarded for safety) and
    `router.replace('/(auth)/login')`.
  - Is mounted once in the root tree (see Modify → `_layout.tsx`), inside `AuthProvider`/`ThemeProvider`
    so it can read `useAuth()` and `useTheme()`.

### Modify
- `frontend/src/useLogout.ts` — collapse to a thin `useContext(LogoutContext)` wrapper that returns
  `{ confirmAndSignOut }`, so existing callers (`LogoutButton`, `profile`) need no change and the
  `Alert.alert`/`signOut`/`router.replace` sequence no longer lives here. The native `Alert` import is
  removed. (Reviewers should be able to `grep` and find `Alert` gone from this file.)
- `frontend/app/_layout.tsx` (root):
  - Wrap `<Inner />` with `<LogoutProvider>` (inside `AuthProvider`).
  - Add a **declarative auth guard**: when `user === null` (loaded, signed out) redirect to
    `/(auth)/login`; when `user` is truthy and the current segment is the `(auth)` group, redirect into
    `/(tabs)/dashboard`. Implement with a `useEffect` on `user` + `useSegments()` calling
    `router.replace`, **or** Expo Router 6's `<Stack.Protected guard={!!user}>` grouping. Keep
    `user === undefined` (still loading) as a no-op so the splash/`ActivityIndicator` shows.
  - Keep `headerRight = user ? () => <LogoutButton /> : undefined` and the per-modal
    `headerRight: undefined` overrides from step 19 exactly as-is.
- `frontend/src/ConfirmModal.tsx` — additively support a `'destructive'` action variant
  (`backgroundColor: colors.owing`, text `colors.primaryText`) so the "Sign out" button reads as
  destructive in both themes. Existing `'primary' | 'default' | 'cancel'` variants are untouched.
- `frontend/src/LogoutButton.tsx` — **no logic change** beyond continuing to call
  `useLogout().confirmAndSignOut`; keep `testID="header-logout"` and the themed icon. (Verify only.)
- `frontend/app/(tabs)/profile.tsx` — **no logic change**; keep the `testID="profile-logout"` row calling
  `useLogout().confirmAndSignOut`. (Verify only.)

## State & API Integration
- **No changes** to `frontend/src/api.ts`.
- **No changes** to `AuthContext`'s public surface. The flow still calls `signOut()` with the default
  (`clearSavedEmail = false`) so `last_login_email` is preserved for PIN quick-login (verified on the
  login screen, which pre-fills `savedEmail`).
- **No changes** to `ThemeContext`; the provider's `ConfirmModal` reads `colors` via `useTheme()`.
- No new `AsyncStorage` keys.

## Files to change
- `frontend/src/useLogout.ts`
- `frontend/app/_layout.tsx`
- `frontend/src/ConfirmModal.tsx`
- `frontend/src/LogoutButton.tsx` *(verify only; likely no edit)*
- `frontend/app/(tabs)/profile.tsx` *(verify only; likely no edit)*
- `CLAUDE.md` *(add Step 21 to the Roadmap and flip it `- [ ]` → `- [x]` after the work is committed)*

## Files to create
- `frontend/src/authNav.ts` *(pure helpers: `authRedirectTarget`, `performSignOut`, `navResetTo`, hrefs)*
- `frontend/src/LogoutProvider.tsx`
- `frontend/src/__tests__/logout.test.ts` *(logic-only unit test — see Definition of Done)*

## New Dependencies
No new dependencies. Uses already-installed `expo-router` (6.x: `router.dismissAll`, `useSegments`,
`Stack.Protected`), `@expo/vector-icons`, and React Native primitives. If `frontend/src/__tests__`
requires a renderer not yet present (e.g. `@testing-library/react-native`), prefer a logic-only test that
needs no new dependency; only add a dev dependency if unavoidable and call it out in review.

## Rules for Implementation
- **Single source of truth (keep step 19's rule).** After this step the confirm + `signOut()` +
  `router.replace('/(auth)/login')` sequence must exist in exactly one place
  (`frontend/src/LogoutProvider.tsx`). `LogoutButton.tsx`, `profile.tsx`, and `useLogout.ts` must not
  re-implement it. A `grep` for `router.replace('/(auth)/login')` in logout code should resolve only to
  the provider (plus the unrelated post-login redirect in `login.tsx`).
- **Cross-platform confirm.** The logout confirmation must work on iOS, Android, **and** web — i.e. use
  the themed `ConfirmModal`, not `Alert.alert`. The destructive button must be reachable on web.
- **Full stack teardown.** Signing out must leave no authenticated screen reachable via back navigation
  (use `router.dismissAll?.()` + `router.replace`, and/or the declarative guard).
- **Preserve saved email.** Logout calls `signOut()` without `clearSavedEmail`, keeping
  `last_login_email` so PIN quick-login still pre-fills the login screen.
- **Keep test hooks stable.** Preserve `testID="header-logout"` and `testID="profile-logout"`; give the
  confirm modal and its actions stable `testID`s (e.g. `logout-confirm`, `logout-confirm-yes`,
  `logout-confirm-cancel`).
- **No logout on modals / auth screens.** Do not regress step 19: modal-presentation screens keep
  `headerRight: undefined` and `(auth)` screens still render no logout control.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, `colors`) and support dynamic light/dark
  mode via `ThemeContext` for the confirm modal and its destructive button.
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) in Section 5 of `CLAUDE.md` —
  untouched by this step; do not alter any expense/split code.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact — untouched here.
- Enforce RBAC on the backend before destructive edits/deletes — untouched here; no backend edits.
- Keep changes strictly scoped to this step; do not refactor unrelated screens, navigation, or styles.

## Definition of Done
A reviewer can verify every item below by running the Expo app (iOS/Android/web) and the test suites.

- [ ] **Logout works on web.** Running `yarn web`, tapping the header logout icon shows the themed
      `ConfirmModal` (not a broken/absent native alert); confirming clears the session and lands on
      `(auth)/login`.
- [ ] **Logout works on native.** On iOS and Android, the header icon and the Profile "Sign out" row both
      open the same themed confirm; confirming returns to `(auth)/login` with the session cleared.
- [ ] **Themed confirm.** The confirm modal renders correctly in light and dark mode (tokens from
      `ThemeContext`); the "Sign out" action is visibly destructive (`colors.owing`).
- [ ] **No back-stack leak.** After logging out from a deep screen (`dashboard → trip/[id] → settle-up`),
      Android hardware-back does **not** return to an authenticated screen; the user stays on
      `(auth)/login`.
- [ ] **Declarative guard.** Forcing `user` to `null` (e.g. simulated token expiry) redirects to
      `(auth)/login` without an explicit logout tap; a signed-in user opening an `(auth)` route is sent to
      the dashboard. `user === undefined` shows the loading indicator (no premature redirect).
- [ ] **Single flow / no Alert.** `grep` confirms the confirm + `signOut()` + `router.replace('/(auth)/login')`
      sequence lives only in `LogoutProvider.tsx`, and `Alert` is gone from `useLogout.ts`.
- [ ] **Saved email preserved.** After logout, the login screen still pre-fills / offers the last-used
      email for PIN quick-login.
- [ ] **Test hooks intact.** `testID="header-logout"` and `testID="profile-logout"` still resolve; the new
      confirm modal actions expose stable `testID`s.
- [ ] **Frontend test green.** A logic-only unit test in `frontend/src/__tests__/logout.test.ts` covers
      the pure helpers in `authNav.ts` — `authRedirectTarget` (the guard decision table) and
      `performSignOut` (signs out before navigating; does not navigate if sign-out fails) — and passes via
      the project's `jest` runner. (No `@testing-library/react-native` is installed, so the testable logic
      is extracted into pure functions rather than rendering components — matching the existing
      `permissions.test.ts` / `composition.test.ts` pattern.)
- [ ] **`yarn lint` passes** in `frontend/` with no new warnings/errors from the changed files.
- [ ] **`pytest` passes** in `backend/` (run from `backend/`): the full suite stays green, confirming this
      frontend-only change introduces no backend regression. (No new backend logic is added, so there is
      no new backend test; the gate is "suite remains green.")
- [ ] **Roadmap updated.** `CLAUDE.md` Step 21 is added to the Implementation Roadmap and flipped from
      `- [ ]` to `- [x]` in the same commit set once the above are verified.
