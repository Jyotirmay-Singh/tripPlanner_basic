# Expense settlement UI evidence — 7 October 2026

These screenshots show the actual frontend components and brand fonts with synthetic local data.
They are renderer fixtures, not production transactions or proof of a native payment journey.
The sample expense is ₹400 split across A, You, Riya and Sam. A's wallet funds its ₹100 share;
You and Riya initially select ₹200 outgoing coverage together.

| Evidence | Observation |
|---|---|
| [Light theme](light-sheet.jpg) | Existing light colors/fonts; separate share, coverage and remaining amounts |
| [Dark theme](dark-sheet.jpg) | Existing dark colors; 640px sheet at 1024 × 900 viewport |
| [Payment choices](payment-choices.jpg) | Direct **Pay A · ₹200** remains primary; optional group route has explanatory copy and visible keyboard focus |
| [320px width](narrow-320.jpg) | Amounts stack, labels wrap, close control remains reachable; content width and scroll width both 257px |
| [Enlarged text](narrow-large-text.jpg) | Browser fixture applies 180% text/line spacing; no horizontal overflow; one scroll region |
| [Saved/offline](saved-offline.jpg) | Confirmation timestamp and persistent refresh warning; no direct payment button and disabled group action |

DOM checks confirmed `role=dialog`, `aria-modal=true` and `aria-checked=true`. Space deselected
Riya and changed **Pay A · ₹200** to **Pay A · ₹100**. Escape closed the sheet and restored focus
to **Open settlement**. Both themes used the 48px control minimum. The renderer API accepted only
reads; no payment or approval was performed through the browser.

The handoff records **17 suites / 172 frontend tests**, TypeScript/lint/whitespace checks, and
**81 backend tests passed / 1 standalone-only test skipped**. Real reviewed HTTP/database checks
and renderer/client checks were separate. Native font scaling, TalkBack, UPI handoff and a complete
client-to-real-API multi-account payment journey remain acceptance gates.
