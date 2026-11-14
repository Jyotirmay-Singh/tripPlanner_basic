# Splitora Play listing assets

Prepared 14 November 2026 for the approved India, free, ad-free launch. These use the
current Splitora S/T identity from `frontend/assets/images/icon.png` and the approved
`main` UI. The deleted GPay-style branch is excluded.

| File | Size | Purpose |
| --- | --- | --- |
| [store-icon-512.png](store-icon-512.png) | 512 × 512 | Current app icon resized for the store |
| [feature-graphic-1024x500.png](feature-graphic-1024x500.png) | 1024 × 500 | Current logo, cream/green/coral brand and expense-management copy |
| [draft-01-group-overview.png](draft-01-group-overview.png) | 1080 × 2400 | Synthetic Goa weekend summary and budget |
| [draft-02-exact-split.png](draft-02-exact-split.png) | 1080 × 2400 | Exact allocations, family roll-up and balanced total |
| [draft-03-settle-up.png](draft-03-settle-up.png) | 1080 × 2400 | Balances and recommended payments |
| [draft-04-receipt.png](draft-04-receipt.png) | 1080 × 2400 | Synthetic receipt attachment and reporting |
| [draft-05-chat-safety.png](draft-05-chat-safety.png) | 1080 × 2400 | Message/person reporting and chat blocking |
| [draft-06-reports.png](draft-06-reports.png) | 1080 × 2400 | PDF and Excel export choices |

## Capture provenance

The six screenshots are **mobile-web drafts**, captured from the final local production
web export before the gallery-only correction, at a 432 × 960 viewport and device scale factor 2.5. They are not native Android
or Play-installed screenshots. Recapture/review the final Android build before submission.
The Exact split input bounds and chat action-sheet bounds were checked before capture;
all six images were visually reviewed.

The exported JavaScript uses the production configuration, with its API and WebSocket
requests intercepted by the local QA browser and redirected to a disposable loopback
API. Other external requests were blocked. Production accounts and records were not used.
The synthetic group has Alex Mehta, Priya Shah and the Rao family (Maya and Dev), four
expenses totaling INR 7,700 and an INR 18,000 budget. No actual payment was made.

[manifest.json](manifest.json) records dimensions, byte sizes, SHA-256 checksums and the
uncommitted application-source fingerprint. The fingerprint covers Git-listed files under
`backend/`, `frontend/` and `shared/`; its exact algorithm is included. Replace it with the
approved release commit and final-artifact evidence when preparing the submission.

Ignored local evidence is in `.release-tmp/play-store-readiness-20261113/`:

- `web-export-reviewed/`: 49-route production export used for these captures.
- `capture-listing.cjs` and `listing-check.json`: six captures and five passing UI checks
  (report, block, unblock, PDF download and XLSX download); no page errors.
- `browser-safety-check.json`: five passing guardian/age-control journeys. Email and identity
  verification were simulated test fixtures, not delivery or legal-verification evidence.
- `qa-browser.cjs`: isolated request routing. Credentials and fixture tokens stay ignored.

The [shared launch handoff](../PLAY_STORE_LAUNCH.md) owns listing copy, remaining owner
approvals, final Android captures and deferred Console steps. Do not upload drafts as
evidence of Play-installed acceptance.
