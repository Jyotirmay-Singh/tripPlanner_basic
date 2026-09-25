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
5. New accounts are then offered an optional **mobile number**. Choose a country and enter or paste
   an international number, then tap **Save and continue** or **Not now**.
6. New accounts are then offered optional **UPI ID** setup. Enter an ID such as `name@bank`, or tap
   **Skip for now**. If you opened an invite, every setup step preserves that invitation. New Google
   users complete the required local password first, then Mobile, then UPI.

### 1.2 Sign in (next time)
- Sign in with **Google**, or use your remembered Gmail address and **password**.
- Tap **Switch** if you want to sign in as a different user.
- If email delivery is enabled, tap **Forgot password?** to receive a single-use reset link.
- If you have not saved a mobile number, each explicit sign-in offers the optional mobile step again.
  **Not now** skips it only for that signed-in session. Reopening the app with a restored session does
  not interrupt you with the prompt.
- In Android builds that include this storage update, an account verified online can restore its
  identity during a temporary server outage while its existing token is valid (up to 30 days from
  sign-in). The update moves an existing Android token into secure device storage without requiring
  a new login. If this is the first launch after updating, or the token has expired, connect to the
  server to finish restoring or sign in. Trip lists and financial data still need a connection in
  this session; offline trip viewing and expense capture are coming in later updates.

### 1.3 Dark mode & sign out
- Bottom-tab **Profile** → toggle **Dark mode**.
- Choose **Sign out** in Profile. If this device has pending actions, the confirmation warns that
  they stay on this device for the same account and cannot sync until it signs in again. Switching
  accounts does not expose those actions to the new account.

### 1.4 Mobile number
- Open **Profile** from the account avatar, then choose **Mobile number** to add or change it. The
  country picker searches by country name, ISO code, or dial code; pasting a complete `+` number
  switches to its country automatically. Saved numbers are normalized internationally.
- People whose app accounts are linked to the same trip can see the full number in that trip's
  **Members** tab. It is not shown in public invitations, trip-list cards, PDF/XLSX reports, audit
  logs, or other exports. Trip admins cannot enter a number for somebody else.
- Tap a saved number in **Members** to choose **Call** or **Copy number**. Calling depends on the
  device; the app reports unsupported calling and clipboard failures explicitly.
- You can remove your number from Profile after confirmation. It disappears from all shared trips;
  the next explicit sign-in offers setup again. There is no SMS/OTP verification or “unverified”
  badge in this release.
- The same number may be used by accounts that do not share a trip. If another linked person in one
  of your trips already uses it, the whole save/join is rejected and the app names the affected trip
  and member; your previous profile value remains unchanged.

### 1.5 Payment details (UPI)
- Open **Profile** from the account avatar, then choose **Payment details** to add or change your
  UPI ID. A saved ID can also be removed after confirmation.
- Returning sign-ins and restored sessions are not prompted automatically, even when no UPI ID is
  saved. Use Profile whenever you want to configure one later.
- Trip Splitter validates the address format but does not verify that you own it. Trip Splitter
  never requests your UPI PIN, bank password, or a QR upload.

### 1.6 Delete your account
- Open **Profile → Delete account**. The review keeps every trip by default and shows your signed
  position separately in each trip's own currency. Family cards also show the family total and any
  family-member rows that are not settled.
- For each trip, choose **Keep**, or—only when eligible—**Leave** or **Dissolve family**. An active
  UPI payment must be resolved first. If you own a trip, the review names the linked account that
  will become owner; when no successor exists, delete that trip through its separate trip-deletion
  flow before deleting the account.
- Keeping an unsettled trip is allowed only after checking the warning. The final account action
  also requires typing uppercase **DELETE** exactly and confirming once more.
- Account deletion permanently removes the login, password, Gmail, mobile and UPI profile, devices,
  tokens, pending join requests, live roster links, and copied personal delivery/account references.
  Kept trips retain their names, member names and stable IDs, transactions, balances, payments, and
  reports. Your retained chat text appears under **Deleted user**. Terminal payment history drops
  UPI snapshots and live account references while keeping amounts, statuses, dates, and transaction
  references.
- Registering the same Gmail later creates a completely new account. It does not restore access to
  retained trips or reconnect an old member row; use the normal invitation and approval flow to
  reclaim an identity.

---

## 2. Bottom-Tab Navigation

| Tab | Purpose |
|---|---|
| 🏠 **Home** | Your two most recently active trips + a live "you owe / you're owed" summary |
| 💼 **Trips** | All trips you've created or joined, most recently active first |
| ➕ **Add** | Pick a trip and instantly add a transaction |
| 📊 **Reports** | One-tap XLSX or PDF download per trip |
| 👤 **Profile** | Your info, mobile number, payment details, dark mode, account deletion, sign out |

---

## 3. Trips

The **Home** tab keeps one **Net position** card for your overall position. When all of your trips
use the same currency it shows one signed total. If your trips use different currencies, it shows a
separate total for each currency rather than adding unlike currencies together. Its message changes
between **You come out ahead**, **You owe overall**, **All settled up**, and a mixed-currency message.

Below that summary, Home shows the first two trips from the server's activity-ordered list. The
**Trips** tab shows the complete list in the same order. Qualifying activity includes saved expense,
roster/join, payment, and completed-settlement changes made by any participant. Pending or failed
actions, trip-setting edits, receipts, chat, role changes, and invite actions do not reorder a trip.
Trip cards keep the same details and do not show a separate “last updated” label.

On the **Trips** tab, every trip card shows your own position for that trip:
- **YOU'RE OWED** with a green exact amount when other members collectively owe you;
- **YOU OWE** with a coral exact amount when you owe other members;
- **Settled** when your whole-unit balance is zero.

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
     The picker contains 26 travel currencies. Every budget, expense, allocation, balance, and
     payment uses whole major-currency units regardless of currency; exchange-rate ratios are the
     only decimal values in normal entry. For example, enter `400`, not `400.00`.
   - **Who are you on this trip?** — choose **I'm an individual** (default) or **I'm in a family**.
     If you pick *family*, enter the **family name**, add a row per member (your name is pre-filled on
     the first row), and tap **"This is me"** on your own row. Your login email + account attach to
     that one member; the family itself never has an email of its own.
3. Tap **Create trip**. You're taken to the trip page; a unique **6-character trip code** is generated (e.g. `AX27R9`).

### 3.2 Share & let others join
- Every trip has one private invitation link. Any linked trip member can copy it under
  **Members → Trip invite link** or share it through WhatsApp, email, or another share target. The
  message includes the link, permanent six-character code, and Android-only APK download URL.
  Owners/admins can reset the link when needed; the previous link then stops working immediately.
- On Android, the link opens the Join wizard directly when Trip Splitter is installed. Without the
  app, it stays on a branded page with **Open Trip Splitter**, **Download Android APK**, and
  **Continue on web**. The APK downloads only after a manual tap. After installing it, return to the
  original invitation and open it again so Android can pass the invitation in.
- Signed-in desktop and iOS web users go straight to the join preview. Existing trip members land on
  that trip's **Summary**; everyone else continues through the normal identity-aware Join wizard.
- Sign-in, registration, Google sign-in, first-time password setup, optional mobile setup, and
  optional UPI setup preserve the invitation. The Join wizard skips manual code entry but still
  performs the identity/approval checks below.
- Build 8 can create secure links once the server rollout flag is enabled, but its installed native
  share sheet still uses the older invite-only wording. The full link + code + Android-download copy
  is live when sharing on web and will reach Android in the next normal APK release.
- Anyone can also use **Home → Join Trip** and enter a valid six-character code manually.
- The Join wizard checks the existing roster **before** offering to create another profile. Available
  **Individuals** and **Family members** are listed separately; choose your name if the owner or an
  admin already added you.
- **If your signed-in Gmail exactly matches** the saved Gmail for that person, tap
  **Join as [name]** to link immediately. Their member ID, expenses, payments, settlements, and other
  trip history stay attached to the same person.
- **If that person has no saved Gmail, or a different Gmail**, tap **Ask to join as [name]**. The
  request waits for an owner or admin to review it in the trip's **Members** tab:
  - You **do not have access to the trip while the request is pending**. The status screen updates
    automatically, and you may cancel the request or create a new profile instead.
  - An owner/admin can **Approve** or **Reject** the request and may include an optional rejection
    reason. Approval links your account to the existing person; if an old Gmail was saved, your Gmail
    replaces it while the old value remains in the request's audit record.
  - The requester receives a device notification identifying the trip when the request is approved
    or declined. It never includes an admin note. Tapping a declined notification returns to the
    request status, where an authorized requester can view that note.
  - After rejection, you can choose a different person immediately, but must wait **24 hours** before
    requesting the same person again.
- If nobody listed is you, tap **None of these is me**, then choose:
  - **New individual** — create your own standalone person and join immediately.
  - **New family** — start a family group and list its members (**list yourself first** — you become
    its first member). The family itself never holds an account or email; each person does.
  Creating either new identity also cancels any pending request you made for that trip.

### 3.3 Edit / delete a trip
- Inside the trip page, the row of action buttons under the header has:
  - **Expense** (+) — add a transaction
  - **Settle Up** — show who owes whom
  - **✏️ pencil** — edit trip name, dates, and budget; the official currency remains locked
  - **🗑 trash** — delete the trip (owner only; removes all expenses and chat history)
- Trip deletion shows the normalized lowercase trip name. Type that lowercase value exactly;
  surrounding spaces are ignored, but uppercase variants are not accepted.

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

> **Mobile numbers are controlled by the linked app user.** An admin cannot type a number into a
> manual member or family row. Once that person links their account, their current Profile number can
> appear here; removing or changing it in Profile updates every trip automatically.

### 4.2 Edit a member
- In the **Members** tab tap the **⋮** on the member row → **Edit member & family details**.
- You can change the name, kind, family members, and each member's email. The **Linked email** field
  appears only for an **individual** — a family has no email of its own, so its members' emails live on
  the member rows instead.
- On the Members tab a family is shown as a card that lists its members **vertically**, each with its
  own email and mobile number when present (missing details simply show nothing) and — for a linked member — an
  **Owner / Admin / You / Linked** badge shown next to **that member's name** (never on the family
  header — admin is always held by a *specific person*, never a whole family).
- A linked standalone person shows the same mobile contact line below their identity. Tap any shown
  number for the shared **Call / Copy number** action sheet.
- **When you change the number of family members**, the app will ask:
  - **"Keep original split"** → past expenses keep their old per-person weight (recommended if those people already paid up).
  - **"Re-split with new members"** → past expenses are recomputed with the new family size.

### 4.3 Avoiding double-counting yourself
**One gmail = one person per trip.** A given email can belong to at most one person on a trip —
across standalone individuals, family entries, and joined app users.
- If you created the trip as **a member of a family** (§3.1 *"This is me"*), your account is already
  attached to that member — there's nothing to reconcile. The trip page's **Summary** tab shows a
  **"You" card** confirming which member you are.
- The Join wizard lists every available standalone individual and family member. An exact Gmail
  match links immediately. Choosing a person with no Gmail or a different saved Gmail sends an
  approval request; approval keeps that person's member ID and all financial history unchanged.
- Owners and admins review pending identity requests at the top of the **Members** tab. The review
  shows the requester's account and chosen roster person. Approving attaches the requester's Gmail
  (replacing any saved Gmail); rejecting can include an optional note. Multiple people may request
  the same roster person, but only one can ultimately be linked to it.
- If the exact Gmail match is wrong and the roster entry has **no trip history**, choosing
  **This isn't me** before creating a new identity safely removes the unused standalone placeholder.
  For a family member, only the mistaken Gmail is detached—the family member remains. An identity
  with expenses, payments, settlements, or other trip history cannot be detached; ask an owner or
  admin to correct the roster instead.
- A user can have only one active join request per trip. Creating a new individual/family or joining
  through an exact match cancels that pending request, so the user cannot be counted twice.

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

### 4.6 Leave a trip yourself
- Open the trip's **Members** tab and use the quiet **Your membership** card. It shows the exact
  identity linked to your account, settlement state, signed position, and any ownership transfer.
- A standalone member can leave only when their precise ledger position is exactly zero. A family
  member can leave only when the family total is exactly zero **and every family-member row is
  settled**. A value that merely rounds to zero is not enough, and an unresolved UPI payment blocks
  departure.
- Leaving a multi-person family removes only your aligned name, stable person ID, email, account
  link, and contact claim. If you are the family's only linked app user, you may leave while keeping
  the other non-app people, or explicitly dissolve the whole settled family. Dissolution is hidden
  while another linked app user remains; if you are also the family's only person, dissolution is
  the only departure choice.
- If you own the trip, ownership transfers first to the earliest remaining live linked admin, then
  to the earliest remaining linked app user in roster order. If neither exists, use the separate
  trip-deletion flow first.
- Historical money remains conserved: old transactions, balances, payments, and reports are kept
  with frozen attribution. Within that trip, your chat becomes **Deleted user** and personal
  account/UPI references are removed. After success, the app returns to Trips.

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
   - Money fields accept signed whole numbers only, so a pasted decimal is rejected. A manual
     exchange-rate ratio may still contain decimals, while a manual final amount must be whole.
     Calculated conversions round half-up to a whole unit in the trip currency.
   - A same-currency transaction uses rate 1 and never contacts the rate service. Foreign-currency
     entry still requires an online connection to the backend, including when you supply a manual
     rate or final amount.
   - The app checks the backend capability before allowing a foreign-currency expense. While it is
     **loading**, the app shows that it is checking. **Enabled** allows quoting and confirmation;
     **disabled** means the rollout switch is off; **unknown** means the server could not be reached
     and offers **Retry**. A temporary refresh failure does not downgrade a capability the server
     already confirmed during the current app session.
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
      total**. The server converts the allocations with the locked rate and distributes any remainder
      whole units deterministically, so their trip-currency sum exactly matches the converted total.
11. **Receipt (optional)** — *Attach image* picks a photo; it's stored as base64 with the transaction.
11. Tap **Save transaction**.
12. If the running total now exceeds the trip budget, a warning dialog asks you to **Cancel** or **Save anyway**.

On Android, other eligible trip members may see **{your trip name} added “{description}”** on
their lock screen; when the description is blank, the category is used instead. The notification
does not include the expense amount, split, receipt, or any account contact details.

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
- **Top spenders bar chart** — ranks each entity (a standalone individual or a whole family) by how much money they actually **paid/fronted** on this trip, biggest first. A small 👤/👥 marker shows individual vs family, and the bar deepens in shade toward the top spender. The header reads e.g. *"₹1,200 spent across 4 entities."*
  - This is **gross spend** — *who paid*, nothing else. It does **not** subtract anyone's share or any settlements, and it ignores the per-person/per-family split mode. Refunds (negative "money back" rows) are **not** subtracted here, so this total can differ from the trip's net *Spent* figure at the top of the screen when refunds exist. Members who paid nothing are still listed (at the bottom) so the roster stays complete.
  - **Tap any entity's name or bar** to open its spending history: the expenses that individual or family fronted, each showing the date, category, split mode, the amount fronted, and *their share* of that expense. The running total at the top equals that entity's bar exactly (gross fronted; refunds excluded, so it can differ from the trip's net *Spent*). Tapping a row opens that expense to edit it.

---

## 7. Balances & Settle Up

### 7.1 Balances tab
Inside a trip, the **Balances** tab shows:
- Each member's **net balance** (positive = others owe them; negative = they owe).
- For each family: the per-person share is shown right under the family total, and the names are listed individually (e.g. *Arjun -₹100, Priya -₹100, Rohan -₹100*). When members took part unevenly, each name reflects **only the expenses that member actually took part in** — a member left out of an expense (unchecked under "Who took part?") owes nothing for it, and the credit from a bill the family paid lands only on the members who shared it. **Settled money drops off**: once a settlement is marked paid, the balances it cleared no longer show — so after settling up, only newer, still-unsettled expenses remain on each member's line. These rows always add up exactly to the family total.
- **Suggested settlements** — a deterministic plan computed by the backend. Typical groups receive a
  true minimum-payment plan; unusually large or search-heavy groups receive a deterministic simplified
  plan that still conserves every settlement unit.
- Every visible balance is a complete, grouped whole-unit value with the trip currency's symbol.
  Currency selectors, field labels, accessibility text, APIs, and reports continue to use ISO codes.

### 7.2 Settle Up screen
Open via the trip's **Settle Up** button. It shows the current backend-authoritative *Pays → Receives*
recommendations. Every supported currency uses whole major units, such as **LKR 1,250**, never
LKR 1,249.67. The group is reconciled together, so total paid always equals total received.
The screen labels the route **Minimum payment plan** when bounded exact optimization succeeded and
**Simplified payment plan** when the efficient fallback was used.

**Recording a payment**
- Tap **Record payment** on a pair to open the amount box. It's **pre-filled with the full amount owed**
  and shows a **Max** hint. You can record the full amount or a positive partial amount up to that
  maximum (**no overpayment**). New and amount-edited payments must be whole major-currency units for
  every supported currency. Tap **Continue**, then confirm
  on the *"Confirm _X_ paid _amount_ to _Y_?"* guard.
- Only the **receiver** (the person getting the money) or a **trip admin/owner** can record a payment —
  the payer can't mark their own debt paid. If a family wallet is receiving, any account linked to a
  person in that family can confirm it. Everyone else can still see the recommendations and history.
- On confirm, every balance is recomputed from the ledger. The remaining amount may shrink, disappear,
  or be routed to a different receiver; a recorded payment itself never changes or disappears.
- Android activity notifications identify the payer, receiver, trip-currency amount, and whether
  this payment only **partly paid** the current payer → receiver payable or **settled** it. That
  classification uses the payable immediately before this payment; unrelated trip debts do not
  change the wording.

**Paying through an external UPI app**
- The account linked to the suggested payer can tap **Pay via UPI**. Choose a linked recipient who
  has saved a UPI ID, enter a full or partial trip-currency amount, and review the server's INR
  conversion. Approving this screen does not move money or change the trip balance.
- Before copying anything or opening an app, Trip Splitter saves a payment attempt with the reviewed
  recipient, UPI ID revision, original trip amount, exact INR amount, quote, and handoff method. If
  that save fails, the UPI ID is not copied and no payment app opens. Only one unresolved attempt can
  exist for the same payer → receiver direction, including when several accounts belong to a payer
  family. Only the exact account that started it can resume it; another payer-family account receives
  a generic pending message and is not shown the attempt snapshot or payer-entered reference.
- In the external payment app, complete all four steps yourself: **paste the copied UPI ID**, **verify
  the recipient shown by the app**, **enter the displayed INR amount**, and **review and authorize the
  payment inside that app**. Trip Splitter does not submit a payment, receive an intent result, or ask
  for your UPI PIN.
- After a copy-only handoff, **I've paid** and **Not paid** appear immediately. After Trip Splitter
  opens a supported UPI app, those choices appear when you return to Trip Splitter. A failed copy or
  launch falls back to copy-only and remains saved so the initiating payer can resume or cancel it
  from **UPI payment activity**. If an app launch reports success but never leaves Trip Splitter, tap
  **App didn't open / continue manually** to reach the same paid/not-paid decision without getting
  stuck.
- If you choose **I've paid**, you may add a transaction reference of up to 100 characters. It is a
  payer-entered note for the involved users—**not bank verification**. The claim then waits for a
  recipient or trip admin/owner to choose **Confirm received** or **Not received**. The payer cannot
  erase a reported-payment claim.
- Any account linked to the receiving family, the trip owner/admin, or the application super-admin
  can see the full incoming attempt and confirm receipt, report non-receipt, retry, or close review.
  Unrelated members and outsiders cannot see attempt details or review it. A recipient/reviewer can
  retry a disputed confirmation or close the review without posting. Unresolved
  attempts expire after 24 hours (the window restarts when a payment is reported or enters review),
  remain in the audit list, and never affect balances by themselves.
- Confirmation recomputes the latest payable for that same direction. It posts exactly one normal
  ledger payment for the smaller of the originally approved trip amount and the current payable. If
  the payable is now zero, the attempt moves to **Needs review** and posts nothing. The activity card
  keeps both the actual INR amount reported outside Trip Splitter and the capped trip-currency ledger
  amount visible.
- Only the selected UPI owner is notified when confirmation is requested; only the initiating payer
  is notified of confirmation, non-receipt, or review closure. A successful confirmation uses the
  same payer, receiver, trip-currency amount, and **partly paid**/**settled** wording as a manual
  payment. Confirmation requests, non-receipt alerts, and review-closure alerts retain their generic
  workflow wording. Tapping one of these notifications opens the matching activity in **Settle Up**.
  Other authorized recipient-family accounts and trip reviewers can use the persisted in-app list.
  Administrators may inspect a recipient's current UPI details for an active recommendation, but only
  a linked payer account can start the handoff.

**Payment history**
- Payment history is chronological and separate from the live route, so recomputation never makes an
  old payment look as though it belonged to a new pair. Each entry shows payer, receiver, amount,
  date/time (in **IST**, UTC+05:30), optional remark, and a **Paid** badge. A UPI row is labeled
  **UPI — recipient confirmed**.
- The receiver or an admin can **edit** (pencil) or **delete** (trash) a payment. Deleting re-opens its
  ledger effect. A note-only edit preserves any legacy decimal amount exactly; changing the amount
  normalizes it to the current whole-unit policy and records an audit entry. Editing a
  recipient-confirmed row opens a remark-only editor: its confirmed ledger amount, UPI amount, quote,
  reference, and confirmation audit are immutable. Deleting that row atomically removes the ledger
  payment and marks the audit **Payment removed** instead of deleting it.
- After all suggested payments are recorded, no whole unit remains to transfer and the trip is settled.

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

On Android, a new message can also produce a push notification for other signed-in trip members.
The notification identifies the sender and trip but never includes the message text; tapping it
opens the matching trip's Chat tab. Chat v1 does not include images, reactions, typing/online
presence, or per-message seen receipts.

Android may show activity notifications on the lock screen. Depending on the activity, this can
expose the trip name, chat sender, expense creator and description/category, or payment parties and
amount. Payment notes, UPI references/IDs, chat text, emails, receipts, credentials, and tokens are
never included in notification copy. Use Android's lock-screen notification-privacy setting if you
do not want these activity details visible while the phone is locked.

---

## 9. Reports & Export (XLSX / PDF)

- Bottom-tab **Reports** lists all your trips.
- Tap **XLSX** to download a professionally-formatted Excel workbook (bold frozen headers, currency
  number format, right-aligned figures), or **PDF** for a print-ready version of the **full report**.
  The XLSX has **five main sheets**, plus a dedicated **Migration Adjustments** sheet when a migrated
  trip has a private reconciliation vector:
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
     **Units** (people counted; an entity counts as 1 in Per-Family), the participant's actual integer
     **Allocation**, and whether that participant received a remainder unit, with a per-expense
     **Subtotal**. Per-Person divides by the total involved people; Per-Family divides by entities.
  4. **Transactions** — an itemised breakdown that expands **every expense into one row per person**,
     showing each member's **Total Payable** (their share of that expense). The canonical amount is
     accompanied by the original amount/currency, locked rate, effective date, provider, mode, and
     original Exact allocations when applicable. Split mode and who paid appear once per expense; a
     person not included in an expense shows **"–"**. A right-side
     pivot totals each person across the whole trip, and a bold **Grand Total** row footers both the
     Amount and Total Payable columns — so **Sum(Amount) = Sum(Total Payable)** and every person's
     pivot total reconciles to the trip total.
  5. **Payments** — a flat log of every settle-up payment recorded on the trip: **Payer**, **Receiver**,
     **Amount** (trip currency), **Date & Time** (shown in **IST**, UTC+05:30), optional **Remark**,
     and a privacy-safe **Source** label. Recipient-confirmed rows say **UPI — recipient confirmed**;
     reports never include the UPI ID, mobile numbers, or payer-entered transaction reference. There is one row per
     payment (three partial payments = three rows), with a bold **Total** row. It also includes the
     whole-unit policy/routing metadata and current recommendations when a settlement plan is open.
  6. **Migration Adjustments** *(when present)* — the private per-entity whole-unit adjustment vector,
     policy version, creation time, and a zero-sum total. It never appears in Transactions or Payments.

The **PDF** is the **full report** in a landscape, print-ready layout: a title block (trip name,
composition, dates, currency) followed by the **Summary**, **Members & Families**, exploded
**Split Allocations**, **Transactions** (with per-person pivot), and **Payments** sections — plus a
dedicated migration-adjustment section when present — built from the same figures as the spreadsheet,
so both reconcile to identical totals. Tables carry styled headers,
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
  providers silently and never saves an unconverted foreign amount. Manual conversion still needs an
  online backend connection so the approved quote can be validated and locked.
- **Precision:** canonical expense conversions are locked at write time and are never re-fetched during
  settlement. Exchange-rate ratios retain decimal precision; active monetary values are rounded
  half-up to whole major-currency units. Automatic splits distribute remainder units payer-first and
  then in visible roster order, so app previews, saved allocations, balances, and reports reconcile.
- **Rollout note for operators:** `MULTI_CURRENCY_EXPENSES_ENABLED` is deliberately **off by default**.
  Before turning it on, run the read-only whole-unit audit and resolve every unsupported trip
  currency or invalid stored amount it reports. Enable the flag only after the compatible backend and
  Android client are live. Whole-unit money is application policy rather than a rollout flag. From the
  backend directory, run `python -m scripts.audit_currency_precision --dry-run` for a read-only audit,
  then use `python -m scripts.migrate_whole_unit_money --dry-run` before any separately authorized
  apply or revert operation.
- **Receipts** are stored in MongoDB GridFS and load on demand; legacy inline receipts remain readable.

---

## 12. Default Admin Account

For demo and testing, use the Gmail address and password configured through `ADMIN_EMAIL` and
`ADMIN_PASSWORD`. There is no PIN credential.

You can create as many additional users as needed via the registration screen.

---

Happy trip-splitting! ✈️
