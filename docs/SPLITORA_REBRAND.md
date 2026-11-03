# Splitora rename and rollout record

Splitora is the official application name from November 1, 2026. This is a rename of the
existing application, with **Splitora** for production and **Splitora QA** for existing QA builds.
The current logo places the mint **S upper-left** and coral **T lower-right**. The Splitora
wordmark, diagonal divider, pin/route motif, and existing visual style are retained.
The initial name-only phase preserved the original T/S artwork; its verification is recorded below.

## Implementation

- Update production and QA Expo naming, local Android labels/project names, UI text,
  accessibility labels, shared invitations, notification instructions, and payment guidance.
- Set the default web title and application-name metadata to Splitora. Existing route titles
  and invitation privacy headers remain in place.
- Update API documentation, email subjects/body/sender display name, PDF author, XLSX creator,
  diagnostic logger name, and exchange-rate User-Agent.
- Update maintained product/developer documentation and use `splitora-android-<version>-build-<code>`
  for new release assets. Existing published artifacts are never renamed or overwritten.

## Preserved identifiers and history

Old-name matches in these categories are intentional:

- Android/iOS package IDs, Kotlin/native module namespaces, signing registrations, Expo project
  IDs/slugs, Google/Firebase client registrations, and Android asset-link associations.
- Existing `tripsplitter-web.vercel.app`, `tripsplitter-api.onrender.com`, verified email addresses,
  service names, download URLs, and the `tripsplitter` URI scheme.
- MongoDB names, disposable test-database prefixes, stored/local/offline data identifiers,
  encryption settings, and notification channel IDs.
- `trip-splitter:stable-invite:v1:` in the invitation signing context and `tripsplitter:coverage:`
  in deterministic financial coverage IDs. These are protocol identity, not display branding.
- Dated release reports, QA/test evidence, historical design/specification records, original
  binary filenames/URLs/hashes, and screenshots. They describe the app as it existed then.
- User-authored data. A product rename does not rewrite users' group names or records.

The obsolete root Expo project is not a release target. Release from `frontend/`; EAS excludes
the checked-in local QA Android project and generates the production native project from
the frontend Expo configuration. The independent `q/` app retains its QA identity and drift.

## Artwork provenance and regeneration

The initial wordmark was edited with the built-in image-generation tool using the existing
`frontend/assets/logo/source-app-logo.jpg` as the reference/edit target. Only the resulting
wordmark band is integrated into the maintained source artwork; the original symbol tile is
stored independently in each app. `assets/logo/source-symbol.png` now holds the later S/T revision.

Prompt: Replace only “TRIP SPLITTER” with the exact text “Splitora” (capital S, lowercase
remainder), centered in the existing bottom band, with the existing slender italic typography
and coral-to-mint colors. Preserve the T/S monogram, route/pin, divider, background, frame,
lighting, canvas, and layout; add no other text or redesign.

Run `node scripts/crop-brand-assets.mjs` from each app to regenerate its assets. Separate symbol
and wordmark sources keep each edit independent. Use `--symbol-only` when changing the symbol
to preserve the current wordmark bytes. The wordmark crop includes the lowercase descender.

## Release acceptance

Record actual verification outcomes and release references below before marking rollout complete.

- [x] Affected frontend/QA and backend email/report/invitation checks pass.
- [x] Type checks, lint, Expo dependency/Doctor checks, full frontend tests, offline backend tests,
      and production web export pass.
- [x] Production configuration and signed APK show Splitora; QA configuration shows Splitora QA.
- [x] The initial name-only revision preserved the original icon/favicon/splash bytes at `54b2c7e`.
- [ ] Login/registration/invitation wordmarks render in light/dark themes and narrow layouts.
- [ ] Signed upgrade, stored/offline data, old invitations, Google sign-in, and push behavior are
      checked on an isolated device/emulator; record any untested authenticated/physical-device steps.
- [ ] Backend and web deploy successfully; signed Android release has a higher version code.
- [ ] Existing stable download endpoint anonymously serves the verified new APK.
- [ ] Existing external app-store names/descriptions, Google OAuth consent branding, and relevant
      provider display names are changed to Splitora, without creating new registrations.
- [x] Remaining old-name matches have been audited against the preserved categories above.

External account display names require access to those existing accounts. Source changes alone
do not prove that console settings or already-installed old binaries have been renamed.

## Verification results

On November 1, 2026: 1,252 frontend tests passed (142 suites; 18 Mongo/client integration tests
remain opt-in), all 70 affected QA tests passed, and 1,086 offline backend tests passed.
Both TypeScript checks, production source lint and affected QA lint passed. Frozen Yarn install,
Expo dependency validation, all 17 Expo Doctor checks, Python dependency validation, and a
44-route production web export passed. Exported home/login/registration/invitation pages each
contain exactly one default title, Splitora. Production/QA resolved names and package IDs passed.
All eight production/QA icon, favicon, adaptive-icon, and splash outputs retained their exact hashes.

The first restricted Windows runs hit file-access errors; the clean verification runs above used
the required file access. The QA retry used a 15-second test timeout after an initial concurrent
run timed out. These were verification-environment changes, not application behavior changes.

Browser control stopped because it could not verify the active browser URL. External Play/App
Store listing and Google OAuth/provider branding are therefore **unverified and pending**;
no external console changes are claimed. Browser theme/narrow-layout visual acceptance also
remains pending until browser control is available. The edited wordmark itself was inspected.

## Prepared Android build 23

[Build 23 verification](releases/android-1.0.0-build-23.md) records the signed Splitora APK and native checks. An isolated emulator upgraded build 22 without losing a harmless app-data marker; fresh install/restart, light/dark/320dp login, and legacy-scheme registration passed. Real sign-in, authenticated offline queues, physical-device checks, and web/invitation visual checks remain unverified.

[Draft PR #73](https://github.com/Jyotirmay-Singh/tripPlanner_basic/pull/73) contains the source and release records. Automatic approval review rejected direct main-branch publication because it triggers production deployments. The current logo needs a replacement APK before publication and stable-link promotion; existing live URLs and the old public artifact remain intact.

Native acceptance completed after recovering an emulator System UI timeout and correcting the
verification helper's outdated registration-heading expectation. No application change was
needed for those retries. The final native run passed with no application crash.

## Latest logo revision: S/T interchange

The later instruction to interchange T and S supersedes the initial decision to retain their
positions. The mint S is now upper-left and the coral T is lower-right. Updated source artwork,
icons, adaptive icons, splash images, favicon, and white notification monograms are mirrored
in production and QA assets, including all 50 checked-in Android density resources.
Both existing `wordmark.png` files remain byte for byte unchanged.

Mode: built-in image editing. Prompt: interchange the existing letter positions while keeping
their colors, sculpted italic styling, divider, pin/route, dark topographic background, and rounded
frame. Keep the Splitora wordmark unchanged. A second image edit repaired inherited lower-frame
copy/paste bands in the text-free master.

Current masters: `frontend/assets/logo/source-symbol.png` and
`frontend/assets/logo/source-app-logo.jpg`, mirrored under `q/`; `app logo.jpg` is the full reference.
Run `node scripts/crop-brand-assets.mjs --symbol-only` from either app to regenerate symbol
outputs while retaining its existing wordmark bytes. Notification SVG paths were repositioned
without redesigning their glyphs and re-rasterized to the existing white/transparent format.

**Build 23 predates this logo revision and is superseded as a release candidate.** Its verified APK
and metadata remain historical evidence. Build and verify a new APK from the updated logo source
before publishing the current design. The proposed build-23 redirect was withdrawn; the existing
stable download target remains build 22 until a replacement artifact is verified and approved.

Logo checks: notification configuration passed in both apps; repeated symbol generation is
deterministic; production/QA symbol outputs match; all 50 native image dimensions and formats
are retained; 40 existing native alpha masks are unchanged. PNG outputs are replaced atomically
to avoid partial images when Windows interrupts an overwrite.
