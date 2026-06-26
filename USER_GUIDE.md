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
| 📊 **Reports** | One-tap XLSX download per trip |
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
If you're already a member of the trip (because you created it or joined it) and a family is later added with **your email**, the app **converts your existing individual entry into the family in place** — same ID, no duplicate. The trip page's **Summary** tab shows a **"You" card** confirming which member you are.

### 4.4 Delete a member
- Tap the **🗑 trash** on the member row.
- Only members **without any transactions linked to them** can be deleted. App-user-linked members cannot be deleted (sign-out and let the owner delete the trip if needed).
- The app prevents creating two members with the same name or the same email in one trip.

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
9. **Partial-family split**: for any **family** you have checked, a chip row appears: *"Split among `1` `2` `3` of 3"*. Tap a number to split only among that many family members for this expense (default = full family).
10. **Receipt (optional)** — *Attach image* picks a photo; it's stored as base64 with the transaction.
11. Tap **Save transaction**.
12. If the running total now exceeds the trip budget, a warning dialog asks you to **Cancel** or **Save anyway**.

### 5.2 Edit or delete a transaction
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

---

## 7. Balances & Settle Up

### 7.1 Balances tab
Inside a trip, the **Balances** tab shows:
- Each member's **net balance** (positive = others owe them; negative = they owe).
- For each family: the per-person share is shown right under the family total, and the names are listed individually (e.g. *Arjun -100.00, Priya -100.00, Rohan -100.00*).
- **Suggested settlements** — the minimum number of payments to zero everyone out.

### 7.2 Settle Up screen
Open via the trip's **Settle Up** button.
- Each suggested settlement is its own card: *From → To, amount*.
- Tap **Mark paid** to record the settlement — balances re-compute instantly.
- When everyone is zeroed out, the screen shows a green **All square!** ✅.

---

## 8. Reports & XLSX Export

- Bottom-tab **Reports** lists all your trips.
- Tap **XLSX** to download an Excel file with four sheets:
  1. **Summary** — trip metadata + totals
  2. **By Category** — every category and its total
  3. **Per Member** — net balance per member, with per-person breakdown
  4. **Per Family Person** — every individual family member with their share
  5. **Transactions** — full log: date, kind, category, description, amount, who paid, who was split among

The download opens in your phone's browser; share or save it from there.

---

## 9. Practical Workflow Example

> "We're going to Goa, 4 of us. I'm splitting with Riddhi (individual) and the Sharma family (3 people)."

1. **You** create the trip *Goa Trip* → code is `GOA526`.
2. Share the code with Riddhi. She registers and joins → she shows up as an individual member.
3. You add **Sharma family** (3 people) as a Member.
4. You pay for dinner ₹2,000 → category *Food*, paid-by *You*, split among all → you'll get ₹1,600 back (you owe ₹400 of the ₹2,000), Riddhi owes ₹400, Sharma family owes ₹1,200 (or ₹400 per Sharma).
5. Someone wants only 2 Sharmas to share the cab ride → on the cab expense, uncheck none, but on the Sharma row pick "Split among 2 of 3" — the math now treats the family as 2 people for that expense only.
6. At the end of the trip, hit **Settle Up** → tap **Mark paid** as each transfer happens.
7. Bottom-tab **Reports → XLSX** to keep a permanent record.

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
