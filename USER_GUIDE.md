# 🧳 Trip Expense Splitter — User Guide

A simple, multi-user mobile app to track trip expenses, split costs fairly between individuals and families, and settle up at the end. Built for Android & iOS via Expo Go.

---

## 1. Getting Started

### 1.1 Create an account
1. Open the app → **Create an account** at the bottom of the sign-in screen.
2. Enter:
   - **Your name** (e.g. *Riddhi*)
   - **Gmail address** (used for login, verification, and password recovery)
   - **Password** (at least 9 characters), entered twice for confirmation
3. Tap **Create account**. You are signed in immediately.
4. Alternatively, choose **Continue with Google**. A new Google user creates a local password once before entering the app.

### 1.2 Sign in (next time)
- Sign in with **Google**, or use your remembered Gmail address and **password**.
- Tap **Switch** if you want to sign in as a different user.
- If email delivery is enabled, tap **Forgot password?** to receive a single-use reset link.

### 1.3 Dark mode & sign out
- Bottom-tab **Profile** → toggle **Dark mode**.
- **Sign out** button (door icon) is on the top-right of every screen.

---

## 2. Bottom-Tab Navigation

| Tab | Purpose |
|---|---|
| 🏠 **Home** | Snapshot of all your trips + a live "you owe / you're owed" summary |
| 💼 **Trips** | All trips you've created or joined; create or join from here |
| ➕ **Add** | Pick a trip and instantly add a transaction |
| 📊 **Reports** | One-tap XLSX or PDF download per trip |
| 👤 **Profile** | Your info, dark mode toggle, sign out |

---

## 3. Trips

The **Home** tab keeps one **Net position** card for your overall position. When all of your trips
use the same currency it shows one signed total. If your trips use different currencies, it shows a
separate total for each currency rather than adding unlike currencies together. Its message changes
between **You come out ahead**, **You owe overall**, **All settled up**, and a mixed-currency message.

On the **Trips** tab, every trip card shows your own position for that trip:
- **YOU'RE OWED** with a green exact amount when other members collectively owe you;
- **YOU OWE** with a coral exact amount when you owe other members;
- **Settled** when your rounded balance is zero.

The amount always uses that trip's currency. On narrow Android phones or with larger accessibility
text, the balance moves below the trip details so the exact value and navigation chevron stay visible.
Settled trips remain tappable and can still be opened normally.

### 3.1 Create a trip
1. **Home → New Trip** (or **Trips → New**).
2. Fill in:
   - **Trip name** (required) — e.g. *Goa December 2026*
   - **Travel date** (DD-MM-YY) — required
   - **Budget** (optional) — used for the over-budget warning
   - **Official currency** — INR by default; choose the currency used for every balance, budget,
     settlement, and report on this trip. It is locked after creation. Normally create separate
     trips for different reporting currencies (for example, an LKR Sri Lanka trip and an NPR Nepal
     trip).
   - **Who are you on this trip?** — choose **I'm an individual** (default) or **I'm in a family**.
     If you pick *family*, enter the **family name**, add a row per member (your name is pre-filled on
     the first row), and tap **"This is me"** on your own row. Your login email + account attach to
     that one member; the family itself never has an email of its own.
3. Tap **Create trip**. You're taken to the trip page; a unique **6-character trip code** is generated (e.g. `AX27R9`).

### 3.2 Share & let others join
- Tap the trip-code chip on the trip header to share the code (WhatsApp / iMessage / email).
- The other person registers in the app, then **Home → Join Trip → enter the code**.
- **If the trip already has a spot for your email** (an admin added you ahead of time — see §4.4),
  the wizard shows a **"We found you on this trip"** step first:
  - If that spot already has expenses or settlements, you can only **take over this profile** —
    a profile with history can't be duplicated.
  - Otherwise you can **take over the profile** (recommended) **or** **join as someone new**;
    joining as new asks you to confirm, then removes the empty placeholder so there's no duplicate.
- **If your email isn't already on the trip**, pick how to join:
  - **Join as Individual** — you pay your own share as a single person.
  - **Join existing Family** — choose a family, then pick **which member you are** from its open
    (unclaimed) spots; your account links to that one person. Families with no open spots are shown
    as **Full**.
  - **Create New Family** — start a new family group and list its members (**list yourself first** —
    you become its first member). The family itself never holds an account or email; each person does.

### 3.3 Edit / delete a trip
- Inside the trip page, the row of action buttons under the header has:
  - **Expense** (+) — add a transaction
  - **Settle Up** — show who owes whom
  - **✏️ pencil** — edit trip name / date / budget / currency
  - **🗑 trash** — delete the trip (owner only; removes all expenses and chat history)

---

## 4. Members & Families

A "member" can be **one individual** or **a family group** (the family is split per family-member when sharing costs).

### 4.1 Add a member
1. Open the trip → **Members** tab → **Add member or family**.
2. Choose **Individual** or **Family**.
3. For **Family**: enter the family name (e.g. *Sharma*) and add one row per member (e.g. *Arjun, Priya, Rohan*). Each family member can optionally carry **their own email** — see below. A family itself has **no email** — only people do.
4. **Linked email** (optional, individuals only): if you enter an email on an **individual** member, the next time the owner of that email **joins the trip via code**, they're automatically linked to that entry. Inside a **family**, the same happens per member via each member's own email. **This is how you avoid counting one person twice.** See §4.3.
5. Tap **Add member**.

> **Emails belong to people, not families.** An email identifies a *person* — a standalone individual
> or **one specific member inside a family**. A family group never has an email of its own. Inside a
> family, each member row has an optional email field. Every email must be a **@gmail.com** address and
> must be **unique across the whole trip** — you can't reuse the same email on two members, two
> families, or a member and an individual. When an app user **joins with a Gmail that matches one
> member's email**, their account is linked to **that specific member** — so several members of one
> family can each join with their own account and appear with a **"Linked"** (or **You/Owner/Admin**)
> badge on the Members tab. (Only an admin sets the emails; the app never lets you type someone else's
> account onto a member.) Adding, changing, or linking an email **never** affects any balance, split,
> settlement, payment, or report.

### 4.2 Edit a member
- In the **Members** tab tap the **⋮** on the member row → **Edit member & family details**.
- You can change the name, kind, family members, and each member's email. The **Linked email** field
  appears only for an **individual** — a family has no email of its own, so its members' emails live on
  the member rows instead.
- On the Members tab a family is shown as a card that lists its members **vertically**, each with its
  own email (members without one simply show no email) and — for a linked member — an
  **Owner / Admin / You / Linked** badge shown next to **that member's name** (never on the family
  header — admin is always held by a *specific person*, never a whole family).
- **When you change the number of family members**, the app will ask:
  - **"Keep original split"** → past expenses keep their old per-person weight (recommended if those people already paid up).
  - **"Re-split with new members"** → past expenses are recomputed with the new family size.

### 4.3 Avoiding double-counting yourself
**One gmail = one person per trip.** A given email can belong to at most one person on a trip —
across standalone individuals, family entries, and joined app users.
- If you created the trip as **a member of a family** (§3.1 *"This is me"*), your account is already
  attached to that member — there's nothing to reconcile. The trip page's **Summary** tab shows a
  **"You" card** confirming which member you are.
- If an admin added a placeholder for your email **before** you join, the Join wizard's identity
  step (§3.2) reconciles it: you **take over** that profile (keeping its expenses) or, when it's
  empty, **join as someone new** and the placeholder is removed. Either way you never end up listed
  twice.
- If your email was added to a **member inside a family**, the Join wizard offers to **link you to
  that member** — you become that specific person within the family (a **"Linked"** badge appears on
  the Members tab), while everyone else in the family is unaffected. Because a given email belongs to
  one person, this is the only join option in that case (there's nothing to remove). Linking, like
  everything about emails, leaves all balances unchanged.

### 4.4 Delete a member
- Tap the **🗑 trash** on the member row.
- Only members **without any transactions linked to them** can be deleted. App-user-linked members cannot be deleted (sign-out and let the owner delete the trip if needed).
- Duplicate **names** are allowed (the app disambiguates them on screen), but a given **email** can
  be used by only one person in the trip — including emails of people who have already joined.

### 4.5 Roles & admins (per person)
- Open a member's **⋮ Manage** screen → **Trip role(s)**. Only the **owner** can change roles.
- **Admin is held by a specific person, never a family as a whole.** For a family, the Manage screen
  lists each member; next to any member **whose own account is linked** you'll see **Make admin** /
  **Remove admin** (and **Make owner**). A member with no linked account can't be an admin until they
  join and link it.
- Admins can add and change members and expenses. **Make owner** hands over ownership (you stay an
  admin). None of this affects any balance — roles are about permissions, not money.

---

## 5. Adding & Managing Transactions

### 5.1 Add an expense (or money back)
1. Trip page → **Expense (+)** button (or bottom-tab **Add → pick trip**).
2. Enter the **amount in the currency that was actually paid**. **Use a leading minus** (e.g.
   `-500`) for *money coming back to the group* — a refund, reimbursement, cancellation, or offer.
   A negative amount is the exact mirror of an expense: the person who **received** the money is
   debited, and everyone it's split among is credited their share. If the money-back is larger than
   the trip's spend so far, a non-blocking note appears (you can still save).
3. Choose the transaction's **currency**. When it differs from the trip's official currency:
   - **Reference rate** previews the historical Frankfurter v2 rate for the expense date. On a
     weekend or bank holiday, the preview shows the previous available rate and its actual date.
   - **Manual / card** lets you enter either the bank/card rate or the final charged/refunded amount
     in the trip currency (as a positive magnitude; the original minus sign is preserved).
   - Check the original amount, converted amount, rate, effective date, provider/cache status, then
     tap **Use this conversion**. A foreign transaction cannot be saved without this confirmation.
   - A same-currency transaction uses rate 1 and never contacts the rate service. If the server's
     rollout flag is off, foreign-currency saving stays disabled until it is enabled.
4. Write a short **description** (e.g. *Dinner at Leela*).
5. Pick from the horizontal **Travel / Accommodation / Local Transportation / Local Sightseeing / Food / Shopping / Other** chips.
6. Set the **date** (DD-MM-YY).
7. **Paid by** — radio-pick the member who paid.
8. **Split among** — **all members are pre-selected by default**. Uncheck any member you don't want to include.
9. **Who took part (partial family)**: for any **family** you have checked, a *"Who took part?"* row lists its members — uncheck anyone who didn't share this expense (default = everyone). In **Per Person** mode this reduces the family's headcount for that expense: the cost is divided by the total *involved* people and each sharer owes that per-person amount (the unchecked members owe 0, and the family's total shrinks accordingly). In **Per Family** mode the family's flat share is unchanged and is simply split among those who took part.
10. **Split mode** — a three-way selector: **Per Person**, **Per Family**, or **Exact**.
    - **Exact amounts**: assign a specific amount to specific people in the transaction's original
      currency. Families are collapsed with a live subtotal — tap to expand and give each member
      their own amount (or untick anyone to leave them at 0); standalone individuals get an amount
      directly. For a refund, allocations remain positive magnitudes even though the transaction
      total is negative. A **reconciliation bar** shows *Assigned* vs *Remaining* and turns green
      when the amounts add up to the original total's magnitude. **Split remaining equally** fills
      the ticked-but-blank rows for you. **Save stays disabled until the amounts exactly equal the
      total**. The server converts the allocations with the locked rate and distributes any rounding
      cents deterministically, so their trip-currency sum exactly matches the converted total.
11. **Receipt (optional)** — *Attach image* picks a photo; it's stored as base64 with the transaction.
11. Tap **Save transaction**.
12. If the running total now exceeds the trip budget, a warning dialog asks you to **Cancel** or **Save anyway**.

### 5.2 Edit or delete a transaction
- The **Expenses** tab lists transactions **newest first**, ordered by each transaction's own **date and time**. A transaction with a time sorts by that time; one with only a date sorts by when it was added, so a freshly added expense appears at the top.
- **Expenses** tab → tap any transaction → opens the **Edit Transaction** screen with the same form pre-filled.
- Converted transactions retain both the original and official-currency values. Editing only the
  description, category, payer, receipt, or participants keeps the locked rate and converted amount.
  Changing the original amount, currency, date, or rate mode requires a new approved preview. Use
  **Fetch a new reference rate** only when you intentionally want to reconvert; saved transactions
  are never silently revalued.
- Or use the **🗑** icon on the transaction row for a quick delete.
- Inside the edit screen there's also a red **Delete transaction** button.

---

## 6. Trip Summary (per-trip dashboard)

Open any trip and look at the **Summary** tab (default tab):

- **You card** — your member entry + your current net balance (always so you know *who you are* in this trip).
- **Budget bar** — green if under, red if over. Shows used / total.
- **Mini-stats** — number of transactions, total refunds (money back to the group).
- **Donut chart** — spend by category, with % in the legend. **Tap any slice or legend row** to open that category's breakdown. The category screen reconciles its net total against gross money paid and refunds, ranks who paid/fronted the positive transactions (family payers stay grouped as one entity), and shows each payer's amount, percentage, and transaction count. The source transactions follow with the largest spends first and refunds afterward.
- **Top spenders bar chart** — ranks each entity (a standalone individual or a whole family) by how much money they actually **paid/fronted** on this trip, biggest first. A small 👤/👥 marker shows individual vs family, and the bar deepens in shade toward the top spender. The header reads e.g. *"INR 1,200.00 spent across 4 entities."*
  - This is **gross spend** — *who paid*, nothing else. It does **not** subtract anyone's share or any settlements, and it ignores the per-person/per-family split mode. Refunds (negative "money back" rows) are **not** subtracted here, so this total can differ from the trip's net *Spent* figure at the top of the screen when refunds exist. Members who paid nothing are still listed (at the bottom) so the roster stays complete.
  - **Tap any entity's name or bar** to open its spending history: the expenses that individual or family fronted, each showing the date, category, split mode, the amount fronted, and *their share* of that expense. The running total at the top equals that entity's bar exactly (gross fronted; refunds excluded, so it can differ from the trip's net *Spent*). Tapping a row opens that expense to edit it.

---

## 7. Balances & Settle Up

### 7.1 Balances tab
Inside a trip, the **Balances** tab shows:
- Each member's **net balance** (positive = others owe them; negative = they owe).
- For each family: the per-person share is shown right under the family total, and the names are listed individually (e.g. *Arjun -100.00, Priya -100.00, Rohan -100.00*). When members took part unevenly, each name reflects **only the expenses that member actually took part in** — a member left out of an expense (unchecked under "Who took part?") owes nothing for it, and the credit from a bill the family paid lands only on the members who shared it. **Settled money drops off**: once a settlement is marked paid, the balances it cleared no longer show — so after settling up, only newer, still-unsettled expenses remain on each member's line. These rows always add up exactly to the family total.
- **Suggested settlements** — a deterministic plan computed by the backend. Typical groups receive a
  true minimum-payment plan; unusually large or search-heavy groups receive a deterministic simplified
  plan that still conserves every settlement unit.
- When whole-unit settlement is enabled for an LKR or NPR trip, each card also shows its **exact
  balance**, **rounded whole-rupee balance**, and **rounding adjustment**. Exact balances stay in the
  ledger; only the payment projection is rounded, and all rounded balances still add to zero.

### 7.2 Settle Up screen
Open via the trip's **Settle Up** button. It shows the current backend-authoritative *Pays → Receives*
recommendations. For LKR and NPR, the optional whole-unit policy produces amounts such as **LKR
1,250**, never LKR 1,249.67. The group is rounded together, so total paid always equals total received.
The screen labels the route **Minimum payment plan** when bounded exact optimization succeeded and
**Simplified payment plan** when the efficient fallback was used.

**Recording a payment**
- Tap **Settle up** on a pair to open the amount box. It's **pre-filled with the full amount owed**
  and shows a **Max** hint. You can record the full amount or a positive partial amount up to that
  maximum (**no overpayment**). When whole-unit LKR/NPR settlement is enabled, new and amount-edited
  payments must be whole rupees; other trips retain decimal payments. Tap **Continue**, then confirm
  on the *"Confirm _X_ paid _amount_ to _Y_?"* guard.
- Only the **receiver** (the person getting the money) or a **trip admin/owner** can record a payment —
  the payer can't mark their own debt paid. If a family wallet is receiving, any account linked to a
  person in that family can confirm it. Everyone else can still see the recommendations and history.
- On confirm, every balance is recomputed from the ledger. The remaining amount may shrink, disappear,
  or be routed to a different receiver; a recorded payment itself never changes or disappears.

**Rounding details & payment history**
- **How rounding was applied** expands an auditable per-member list of exact balance, rounded payable
  or receivable, and adjustment.
- Payment history is chronological and separate from the live route, so recomputation never makes an
  old payment look as though it belonged to a new pair. Each entry shows payer, receiver, amount,
  date/time (in **IST**, UTC+05:30), optional remark, and a **Paid** badge.
- The receiver or an admin can **edit** (pencil) or **delete** (trash) a payment. Deleting re-opens its
  ledger effect. Legacy decimal LKR/NPR payments remain valid; a note-only edit preserves the original
  amount exactly, while changing the amount must follow the current whole-unit policy.
- After all suggested whole-rupee payments are recorded, **Settled within rounding** means no whole
  rupee remains to transfer. The disclosed precise residual is retained and carries into later expenses.

Payments are durable: adding new expenses later never voids them — a recorded payment keeps offsetting
the recomputed balance (and can even flip who owes whom if someone has now overpaid). Settlement never
fetches a new exchange rate; it uses the canonical trip-currency amount locked onto each expense.

---

## 8. Trip Chat

Open any trip and swipe the trip tabs to **Chat**. Chat is shared by the signed-in app users who are
linked to people on that trip; a roster-only placeholder cannot chat until that person joins or
claims the profile.

- New messages appear live. If the connection drops, the **Live** label changes to
  **Reconnecting** and missed MongoDB-backed messages are recovered automatically.
- Every message shows the sender's **trip member name**. A linked family member appears as, for
  example, **Priya · Sharma Family**, so their identity is clear outside the nested Members list.
  That sent-time label stays on old messages even if the roster is renamed later.
- The Chat tab shows the exact unread count, capped visually at **99+**. Read position is saved to
  the account, so it follows you between phone and web. Messages you send do not count as unread.
- Messages are plain text and can contain up to **2,000 characters**. A message appears immediately
  while it is being saved; if the network request fails, tap **Retry** on that message.
- Tap one of **your own** saved messages to **Edit message** or **Delete message**. You can do this at
  any time while you still belong to the trip. An edit is marked *edited*. Deletion permanently
  removes the original text and leaves a **Message deleted** placeholder for conversation order.
- The trip owner can open **Chat options → Clear chat history**. After confirmation, this
  permanently removes all existing messages and deletion placeholders for every member. Admins do
  not receive this owner-only power.
- Removing a linked person from the trip immediately removes their chat access. Their historical
  sender label remains understandable to the people who still have access.

Chat v1 does not include images, reactions, typing/online presence, per-message seen receipts, or
device push notifications.

---

## 9. Reports & Export (XLSX / PDF)

- Bottom-tab **Reports** lists all your trips.
- Tap **XLSX** to download a professionally-formatted Excel workbook (bold frozen headers, currency
  number format, right-aligned figures), or **PDF** for a print-ready version of the **full report**.
  The XLSX has **five sheets**:
  1. **Summary** — trip header (name, dates, share code, currency, member composition, budget,
     **Total Spent**), a **Spend by entity** block ranking who paid the most (**Gross Spent**,
     descending), and the **By category** totals.
  2. **Members & Families** — one auditable table: each individual and each family member grouped
     under its family with a **family subtotal**, then standalone individuals, then a grand **TOTAL**.
     Money columns reconcile exactly: **Net Balance = Gross Spent − Share of Expenses + Settlements**.
     The **Settlements** column now includes **both** recorded settlements **and partial payments**
     (see §7.2), so it always matches the balances the app shows. (Family-member rows show only their
     share of the family's **Net Balance**, which sums to the family total.)
  3. **Split Math** — the full split breakdown, one block per expense: every participant row shows
     **Units** (people counted; an entity counts as 1 in Per-Family), **Per-Unit Cost**, and
     **Allocated** amount, with a per-expense **Subtotal**. Per-Person divides by the total involved
     people; Per-Family divides by the number of entities.
  4. **Transactions** — an itemised breakdown that expands **every expense into one row per person**,
     showing each member's **Total Payable** (their share of that expense). The canonical amount is
     accompanied by the original amount/currency, locked rate, effective date, provider, mode, and
     original Exact allocations when applicable. Split mode and who paid appear once per expense; a
     person not included in an expense shows **"–"**. A right-side
     pivot totals each person across the whole trip, and a bold **Grand Total** row footers both the
     Amount and Total Payable columns — so **Sum(Amount) = Sum(Total Payable)** and every person's
     pivot total reconciles to the trip total.
  5. **Payments** — a flat log of every settle-up payment recorded on the trip: **Payer**, **Receiver**,
     **Amount** (trip currency), and **Date & Time** (shown in **IST**, UTC+05:30), one row per payment
     (three partial payments = three rows), with a bold **Total** row. For whole-unit LKR/NPR trips,
     this tab also includes the exact-versus-rounded balance audit, policy/routing metadata, and the
     current whole-rupee recommendations.

The **PDF** is the **full report** in a landscape, print-ready layout: a title block (trip name,
composition, dates, currency) followed by the **Summary**, **Members & Families**, exploded
**Transactions** (with per-person pivot), and **Payments** sections — plus the whole-unit settlement
audit when enabled — built from the same figures as the spreadsheet, so both reconcile to identical totals. Tables carry styled headers,
zebra striping, red/parenthesised negatives, bold totals, and a *Page X of Y* footer.

"Gross Spent" (a.k.a. Total Spent) is the amount an entity actually fronted — not net of their own
share — the same figure the trip card's **SPENT** total shows.

The download opens in your phone's browser; share or save it from there.

---

## 10. Practical Workflow Example

> "We're going to Goa, 4 of us. I'm splitting with Riddhi (individual) and the Sharma family (3 people)."

1. **You** create the trip *Goa Trip* → code is `GOA526`.
2. Share the code with Riddhi. She registers and joins → she shows up as an individual member.
3. You add **Sharma family** (3 people) as a Member.
4. You pay for dinner ₹2,000 → category *Food*, paid-by *You*, split among all → you'll get ₹1,600 back (you owe ₹400 of the ₹2,000), Riddhi owes ₹400, Sharma family owes ₹1,200 (or ₹400 per Sharma).
5. Someone wants only 2 Sharmas to share the cab ride → on the cab expense, under the Sharma family's *"Who took part?"* row uncheck the 1 Sharma who skipped it. In **Per Person** mode the family is now counted as 2 people for that expense only: the cab is divided by the total involved people, those 2 Sharmas each owe the per-person amount, and the third owes 0.
6. At the end of the trip, hit **Settle Up**. As money changes hands, the **receiver** (or an admin)
   taps **Settle up** on each current recommendation and confirms the amount — all at once or in
   allowed partial increments. Each payment is logged permanently, and the backend recalculates the
   remaining route; once no payment remains it shows **All square!** or **Settled within rounding**.
7. Bottom-tab **Reports → XLSX or PDF** to keep a permanent record.

---

## 11. Tips & Troubleshooting

- **Icons missing or "font is empty"?** Close Expo Go fully and reopen → re-scan the QR. Asset caches can corrupt; this re-downloads them.
- **Reset emails not arriving?** The Resend account is in test mode — emails only deliver to the account owner. Verify a domain at resend.com/domains to send to anyone. Until then, the reset token is also printed in the backend logs (admin can fetch it).
- **Forgot password?** Sign-in screen → *Forgot password?* → email link → choose a new password. If the link is hidden, outbound email is currently disabled; use Google sign-in or contact the administrator.
- **Want to edit a past family split?** Edit the family → choose **Re-split with new members** when prompted. To preserve the old splits, choose **Keep original**.
- **Currency conversion unavailable?** The backend rollout flag may still be off, the historical rate
  may be unavailable, or the provider may be temporarily unreachable. Retry, use an already cached
  result when offered, or enter a manually confirmed bank/card conversion; the app never switches
  providers silently and never saves an unconverted foreign amount.
- **Precision:** canonical expense conversions are locked at write time and are never re-fetched during
  settlement. Balance shares are calculated with deterministic 12-decimal scaled integers. The
  compatibility balance display remains two-decimal; when enabled, LKR/NPR settlement is a separate
  zero-sum whole-rupee projection. Other currency-specific increments are still deferred.
- **Receipts** are stored in MongoDB GridFS and load on demand; legacy inline receipts remain readable.

---

## 12. Default Admin Account

For demo and testing, use the Gmail address and password configured through `ADMIN_EMAIL` and
`ADMIN_PASSWORD`. There is no PIN credential.

You can create as many additional users as needed via the registration screen.

---

Happy trip-splitting! ✈️
