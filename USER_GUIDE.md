# 🧳 Trip Expense Splitter — User Guide

A simple, multi-user mobile app to track trip expenses, split costs fairly between individuals and families, and settle up at the end. Built for Android & iOS via Expo Go.

---

## 1. Getting Started

### 1.1 Create an account
1. Open the app → **Create an account** at the bottom of the Sign-in screen.
2. Enter:
   - **Your name** (e.g. *Riddhi*)
   - **Email** (used for login & PIN-reset emails)
   - **4-digit PIN** (this is your **only** login credential — choose something memorable but private)
3. Tap **Create account**. You are signed in immediately.

### 1.2 Sign in (next time)
- The app **remembers your email**. On subsequent launches you'll only see your 4-digit PIN field.
- Tap **Switch** if you want to sign in as a different user.
- Forgot your PIN? Tap **Forgot PIN?** → enter your email → check your inbox for a reset link → set a new PIN.

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

### 3.1 Create a trip
1. **Home → New Trip** (or **Trips → New**).
2. Fill in:
   - **Trip name** (required) — e.g. *Goa December 2026*
   - **Travel date** (DD-MM-YY) — required
   - **Budget** (optional) — used for the over-budget warning
   - **Currency** — INR by default; swipe horizontally to pick another
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

### 3.3 Edit / delete a trip
- Inside the trip page, the row of action buttons under the header has:
  - **Expense** (+) — add a transaction
  - **Settle Up** — show who owes whom
  - **✏️ pencil** — edit trip name / date / budget / currency
  - **🗑 trash** — delete the trip (owner only; removes all expenses)

---

## 4. Members & Families

A "member" can be **one individual** or **a family group** (the family is split per family-member when sharing costs).

### 4.1 Add a member
1. Open the trip → **Members** tab → **Add member or family**.
2. Choose **Individual** or **Family**.
3. For **Family**: enter the family name (e.g. *Sharma*) and a comma-separated list of names (e.g. *Arjun, Priya, Rohan*).
4. **Linked email** (optional): if you enter an email here, the next time the owner of that email **joins the trip via code**, they're automatically linked to this member entry. **This is how you avoid counting one person twice.** See §4.3.
5. Tap **Add member**.

### 4.2 Edit a member
- In the **Members** tab tap the **✏️ pencil** on the member row.
- You can change the name, kind, family members and linked email.
- **When you change the number of family members**, the app will ask:
  - **"Keep original split"** → past expenses keep their old per-person weight (recommended if those people already paid up).
  - **"Re-split with new members"** → past expenses are recomputed with the new family size.

### 4.3 Avoiding double-counting yourself
**One gmail = one person per trip.** A given email can belong to at most one person on a trip —
across standalone individuals, family entries, and joined app users.
- If you're already a member of the trip and a family is later added with **your email**, the app
  **converts your existing individual entry into the family in place** — same ID, no duplicate. The
  trip page's **Summary** tab shows a **"You" card** confirming which member you are.
- If an admin added a placeholder for your email **before** you join, the Join wizard's identity
  step (§3.2) reconciles it: you **take over** that profile (keeping its expenses) or, when it's
  empty, **join as someone new** and the placeholder is removed. Either way you never end up listed
  twice.

### 4.4 Delete a member
- Tap the **🗑 trash** on the member row.
- Only members **without any transactions linked to them** can be deleted. App-user-linked members cannot be deleted (sign-out and let the owner delete the trip if needed).
- Duplicate **names** are allowed (the app disambiguates them on screen), but a given **email** can
  be used by only one person in the trip — including emails of people who have already joined.

---

## 5. Adding & Managing Transactions

### 5.1 Add an expense (or money back)
1. Trip page → **Expense (+)** button (or bottom-tab **Add → pick trip**).
2. Enter the **amount** in the trip's currency. **Use a leading minus** (e.g. `-500`) for *money coming back to the group* — a refund, reimbursement, cancellation, or offer. A negative amount is the exact mirror of an expense: the person who **received** the money is debited, and everyone it's split among is credited their share. If the money-back is larger than the trip's spend so far, a non-blocking note appears (you can still save).
4. Write a short **description** (e.g. *Dinner at Leela*).
5. Pick from the horizontal **Travel / Accommodation / Local Transportation / Local Sightseeing / Food / Shopping / Other** chips.
6. Set the **date** (DD-MM-YY).
7. **Paid by** — radio-pick the member who paid.
8. **Split among** — **all members are pre-selected by default**. Uncheck any member you don't want to include.
9. **Who took part (partial family)**: for any **family** you have checked, a *"Who took part?"* row lists its members — uncheck anyone who didn't share this expense (default = everyone). In **Per Person** mode this reduces the family's headcount for that expense: the cost is divided by the total *involved* people and each sharer owes that per-person amount (the unchecked members owe 0, and the family's total shrinks accordingly). In **Per Family** mode the family's flat share is unchanged and is simply split among those who took part.
10. **Split mode** — a three-way selector: **Per Person**, **Per Family**, or **Exact**.
    - **Exact amounts**: assign a specific amount to specific people. Families are collapsed with a live subtotal — tap to expand and give each member their own amount (or untick anyone to leave them at 0); standalone individuals get an amount directly. A **reconciliation bar** shows *Assigned* vs *Remaining* and turns green when the amounts add up to the total. **Split remaining equally** fills the ticked-but-blank rows for you. **Save stays disabled until the amounts exactly equal the total** — the same rule is re-checked on the server, so an unbalanced Exact expense can never be saved. Balances, per-member breakdowns, and reports all use the exact amounts you typed.
11. **Receipt (optional)** — *Attach image* picks a photo; it's stored as base64 with the transaction.
11. Tap **Save transaction**.
12. If the running total now exceeds the trip budget, a warning dialog asks you to **Cancel** or **Save anyway**.

### 5.2 Edit or delete a transaction
- The **Expenses** tab lists transactions **newest first**, ordered by each transaction's own **date and time**. A transaction with a time sorts by that time; one with only a date sorts by when it was added, so a freshly added expense appears at the top.
- **Expenses** tab → tap any transaction → opens the **Edit Transaction** screen with the same form pre-filled.
- Or use the **🗑** icon on the transaction row for a quick delete.
- Inside the edit screen there's also a red **Delete transaction** button.

---

## 6. Trip Summary (per-trip dashboard)

Open any trip and look at the **Summary** tab (default tab):

- **You card** — your member entry + your current net balance (always so you know *who you are* in this trip).
- **Budget bar** — green if under, red if over. Shows used / total.
- **Mini-stats** — number of transactions, total refunds (money back to the group).
- **Donut chart** — spend by category, with % in the legend. **Tap any slice or legend row** to drill down to all transactions in that category.
- **Top spenders bar chart** — ranks each entity (a standalone individual or a whole family) by how much money they actually **paid/fronted** on this trip, biggest first. A small 👤/👥 marker shows individual vs family, and the bar deepens in shade toward the top spender. The header reads e.g. *"INR 1,200.00 spent across 4 entities."*
  - This is **gross spend** — *who paid*, nothing else. It does **not** subtract anyone's share or any settlements, and it ignores the per-person/per-family split mode. Refunds (negative "money back" rows) are **not** subtracted here, so this total can differ from the trip's net *Spent* figure at the top of the screen when refunds exist. Members who paid nothing are still listed (at the bottom) so the roster stays complete.
  - **Tap any entity's name or bar** to open its spending history: the expenses that individual or family fronted, each showing the date, category, split mode, the amount fronted, and *their share* of that expense. The running total at the top equals that entity's bar exactly (gross fronted; refunds excluded, so it can differ from the trip's net *Spent*). Tapping a row opens that expense to edit it.

---

## 7. Balances & Settle Up

### 7.1 Balances tab
Inside a trip, the **Balances** tab shows:
- Each member's **net balance** (positive = others owe them; negative = they owe).
- For each family: the per-person share is shown right under the family total, and the names are listed individually (e.g. *Arjun -100.00, Priya -100.00, Rohan -100.00*). When members took part unevenly, each name reflects **only the expenses that member actually took part in** — a member left out of an expense (unchecked under "Who took part?") owes nothing for it, and the credit from a bill the family paid lands only on the members who shared it. **Settled money drops off**: once a settlement is marked paid, the balances it cleared no longer show — so after settling up, only newer, still-unsettled expenses remain on each member's line. These rows always add up exactly to the family total.
- **Suggested settlements** — the minimum number of payments to zero everyone out.

### 7.2 Settle Up screen
Open via the trip's **Settle Up** button. It shows the live, minimum set of *Pays → Receives* pairs
that zero everyone out. Each pair is a card with the current amount payable, and you **record real
payments** — including **partial** ones — against it (Splitwise-style).

**Recording a payment**
- Tap **Settle up** on a pair to open the amount box. It's **pre-filled with the full amount owed**
  and shows a **Max** hint; you can change it to any amount greater than 0 and up to that maximum
  (**no overpayment**). Tap **Continue**, then confirm on the *"Confirm _X_ paid _amount_ to _Y_?"*
  guard.
- Only the **receiver** (the person getting the money) or a **trip admin/owner** can record a payment —
  the payer can't mark their own debt paid. Everyone else can still see the amounts, badges, and log.
- On confirm, the pair's **headline amount shrinks** by what was paid (the top number *is* the
  remaining balance), and the payment is added to the log below the card. **Everyone's balance updates**.

**Statuses & log**
- A pair that's been paid in part shows a **Partially Paid** badge and a small progress bar
  (*paid of original*). Keep recording payments until it's cleared.
- When a pair is fully paid off it moves to a **Settled** section with a green **Paid** badge; its
  payments stay listed. When *everything* is square the screen shows **All square!** ✅.
- Each log entry reads *"X paid _amount_ to Y"* with the **date & time** (shown in **IST**, UTC+05:30). The receiver or an admin can
  **edit** (pencil) or **delete** (trash) an entry — deleting re-opens that much of the balance.

Payments are durable: adding new expenses later never voids them — a recorded payment keeps offsetting
the recomputed balance (and can even flip who owes whom if someone has now overpaid).

---

## 8. Reports & Export (XLSX / PDF)

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
     showing each member's **Total Payable** (their share of that expense). Amount, split mode, and who
     paid appear once per expense; a person not included in an expense shows **"–"**. A right-side
     pivot totals each person across the whole trip, and a bold **Grand Total** row footers both the
     Amount and Total Payable columns — so **Sum(Amount) = Sum(Total Payable)** and every person's
     pivot total reconciles to the trip total.
  5. **Payments** — a flat log of every settle-up payment recorded on the trip: **Payer**, **Receiver**,
     **Amount** (trip currency), and **Date & Time** (shown in **IST**, UTC+05:30), one row per payment
     (three partial payments = three rows), with a bold **Total** row.

The **PDF** is the **full report** in a landscape, print-ready layout: a title block (trip name,
composition, dates, currency) followed by the **Summary**, **Members & Families**, exploded
**Transactions** (with per-person pivot), and **Payments** sections — the same sections, built from the
same figures as the spreadsheet, so both reconcile to identical totals. Tables carry styled headers,
zebra striping, red/parenthesised negatives, bold totals, and a *Page X of Y* footer.

"Gross Spent" (a.k.a. Total Spent) is the amount an entity actually fronted — not net of their own
share — the same figure the trip card's **SPENT** total shows.

The download opens in your phone's browser; share or save it from there.

---

## 9. Practical Workflow Example

> "We're going to Goa, 4 of us. I'm splitting with Riddhi (individual) and the Sharma family (3 people)."

1. **You** create the trip *Goa Trip* → code is `GOA526`.
2. Share the code with Riddhi. She registers and joins → she shows up as an individual member.
3. You add **Sharma family** (3 people) as a Member.
4. You pay for dinner ₹2,000 → category *Food*, paid-by *You*, split among all → you'll get ₹1,600 back (you owe ₹400 of the ₹2,000), Riddhi owes ₹400, Sharma family owes ₹1,200 (or ₹400 per Sharma).
5. Someone wants only 2 Sharmas to share the cab ride → on the cab expense, under the Sharma family's *"Who took part?"* row uncheck the 1 Sharma who skipped it. In **Per Person** mode the family is now counted as 2 people for that expense only: the cab is divided by the total involved people, those 2 Sharmas each owe the per-person amount, and the third owes 0.
6. At the end of the trip, hit **Settle Up**. As money changes hands, the **receiver** (or an admin) taps **Settle up** on each pair and confirms the amount — pay it all at once or in parts. Each payment shrinks the amount still owed and is logged with a date & time; the pair shows **Partially Paid**, then **Paid** once it's cleared.
7. Bottom-tab **Reports → XLSX or PDF** to keep a permanent record.

---

## 10. Tips & Troubleshooting

- **Icons missing or "font is empty"?** Close Expo Go fully and reopen → re-scan the QR. Asset caches can corrupt; this re-downloads them.
- **Reset emails not arriving?** The Resend account is in test mode — emails only deliver to the account owner. Verify a domain at resend.com/domains to send to anyone. Until then, the reset token is also printed in the backend logs (admin can fetch it).
- **Forgot PIN?** Sign-in screen → *Forgot PIN?* → email link → set a new PIN. If email isn't delivering yet, ask the admin.
- **Want to edit a past family split?** Edit the family → choose **Re-split with new members** when prompted. To preserve the old splits, choose **Keep original**.
- **Currency** is per-trip; the app does not auto-convert between currencies (manual entry only).
- **Receipts** are saved as base64 inside the transaction — they sync between users in real time when they refresh the trip.

---

## 11. Default Admin Account

For demo & testing:
- Email: `admin@trip.app`
- PIN: `1234`

You can create as many additional users as needed via the registration screen.

---

Happy trip-splitting! ✈️
