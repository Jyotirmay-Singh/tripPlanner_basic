# Google Play — Internal Testing Setup

Distribute Trip Splitter to testers through the Play Store (up to 100 testers, **no
"unknown source" / Play Protect warnings**, and **no review delay**). This reuses the same
Expo project and the existing `production` EAS profile (which builds a Play-ready `.aab`
with the prod backend URL + Google client IDs baked in). Nothing about the backend, split
engine, auth, or the Vercel/Render deploys changes.

App: **Trip Splitter** · package `com.tripsplitter.app` · Play App Signing (Google-managed).

---

## Step 0 — Create a Google Play Developer account  *(you)*

1. Go to <https://play.google.com/console> → **Get started / Create account** → **Personal**
   (unless you have a registered business). Pay the **one-time $25**.
2. Complete **identity verification** (legal name, address, phone; sometimes a photo ID).
   **This can take a few hours to a few days** — you cannot publish anything until it clears.
3. Note: the "20 testers for 14 days" requirement Google added for new personal accounts
   applies to **Production** access only. **Internal testing is exempt** — you can test as
   soon as the account is verified.

## Step 1 — Create the app  *(you, after verification)*

Play Console → **Create app**:
- App name: **Trip Splitter** · Default language: your choice · Type: **App** · **Free**.
- Accept the developer-program / US-export declarations.
- (The package `com.tripsplitter.app` is registered automatically on your first bundle upload.)

## Step 2 — Build the `.aab`  *(me — done/in progress)*

`eas build --platform android --profile production` → a Play-ready **app bundle**, prod env
baked in, `versionCode` auto-incremented by EAS.
<!-- AAB build + download link recorded below once the build finishes -->
- Build page: `<pending>`
- Direct `.aab`: `<pending>`

## Step 3 — Create the Internal testing release + upload  *(you)*

Play Console → **Testing → Internal testing → Create new release**:
- When prompted about **Play App Signing**, **accept** (Google generates & manages the app
  signing key — recommended, and required for new apps).
- **Upload** the `.aab` from Step 2.
- Add a short release note (e.g. "Initial internal test build").
- **Save → Review release**. It will flag incomplete "App content" — finish Step 5, then
  **Start rollout to Internal testing**.

## Step 4 — Add testers + share the link  *(you)*

Internal testing → **Testers** tab:
- Create an **email list** and add tester **Gmail addresses** (Google accounts), up to 100.
- Save, then copy the **"Copy link" / opt-in URL** and send it to testers.
- Each tester opens the link → **Accept invitation** → installs from the Play Store link.
  (Can take a few minutes to appear. They must use the **same Google account** on their phone.)

## Step 5 — Required "App content" declarations  *(you — needed before rollout)*

Play Console → **Policy → App content**. Complete each required item:
- **Privacy policy** — **required** (the app collects emails/names/accounts). See below.
- **App access** — the app needs sign-in, so provide **test credentials** (a demo
  `@gmail.com` + password + PIN) so reviewers/testers aren't blocked.
- **Ads** — declare **No ads** (assuming none).
- **Content rating** — fill the questionnaire (utility app → typically *Everyone*).
- **Target audience & content** — select age groups (not directed at children).
- **Data safety** — declare what's collected (email, name, app activity), that it's
  **encrypted in transit**, and whether accounts can be deleted. Be accurate.
- **Financial features / Government apps** — **No**.

## Step 6 — Google Sign-In on the Play build (SHA-1)  *(you + me)*

Because Play re-signs the app, the delivered app's certificate is **Google's app-signing
key**, whose SHA-1 differs from the EAS upload key. To keep "Continue with Google" working:

1. After the first upload: Play Console → **Test and release → Setup → App signing**. Copy:
   - **App signing key certificate → SHA-1** (Google's key — what end users get)
   - **Upload key certificate → SHA-1** (should equal the EAS keystore below)
2. In **Google Cloud Console → APIs & Services → Credentials → the Android OAuth client**
   (`com.tripsplitter.app`), **add the App-signing-key SHA-1** (keep the EAS/upload one too).

**EAS upload-key SHA-1** (already have this from the preview APK; the Play upload-key SHA-1
should match it):
```
B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B
```

---

## Privacy policy (required)

The app handles personal data (accounts, emails), so Play requires a **public privacy-policy
URL**. Easiest option: add a static `/privacy` page to the existing Vercel web app and use
that URL. (Ask and I'll draft the page + route — it's additive and doesn't touch app logic.)

## Quick gotchas
- Internal testing has **no review wait** (unlike closed/production tracks).
- Every new upload must have a **higher `versionCode`** — EAS handles this automatically
  (`appVersionSource: "remote"`).
- Manual upload is used here — no Google Cloud **service account** is needed. (If you later
  want one-command `eas submit` releases, that's a separate, optional setup.)
