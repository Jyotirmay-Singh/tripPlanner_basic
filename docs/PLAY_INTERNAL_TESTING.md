# Google Play — Internal Testing Setup

Distribute Trip Splitter to testers through the Play Store (up to 100 testers, **no
"unknown source" / Play Protect warnings**, and **no review delay**). This reuses the same
Expo project and the existing `production` EAS profile (which builds a Play-ready `.aab`
with the prod backend URL + public Google Web/iOS client IDs baked in). Nothing about the backend, split
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
  `@gmail.com` + password) so reviewers/testers aren't blocked.
- **Ads** — declare **No ads** (assuming none).
- **Content rating** — fill the questionnaire (utility app → typically *Everyone*).
- **Target audience & content** — select age groups (not directed at children).
- **Data safety** — declare what's collected (email, name, app activity), that it's
  **encrypted in transit**, and whether accounts can be deleted. Be accurate.
- **Financial features / Government apps** — **No**.

## Step 6 — Google Sign-In on the Play build (SHA-1)  *(you + me)*

Android sign-in uses Credential Manager. The Web OAuth client ID is passed at runtime and becomes
the ID token's audience, while an Android OAuth client authorizes the installed binary by exact
package/SHA-1. There is no Android redirect URI.

Because Play re-signs the app, the certificate on a Play-installed build is **Google's app-signing
key**, whose SHA-1 differs from the EAS upload key. To keep "Continue with Google" working:

1. After the first upload: Play Console → **Test and release → Setup → App signing**. Copy:
   - **App signing key certificate → SHA-1** (Google's key — what end users get)
   - **Upload key certificate → SHA-1** (should equal the EAS keystore below)
2. In the intended **Google Cloud Console → APIs & Services → Credentials** project, create or
   verify an **Android** OAuth client for:
   - Package `com.tripsplitter.app`
   - The **App signing key certificate SHA-1** copied above
3. Keep the EAS-preview registration as a separate Android OAuth client entry for the same package
   plus the EAS SHA-1. Google Cloud models each package/certificate pair separately.
4. Verify the same Cloud project contains the Web OAuth client referenced by
   `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, and verify Render's `GOOGLE_CLIENT_ID` accepted-audience list
   includes that Web ID. Do not use an Android client ID as `webClientId` and do not add a client
   secret to the app or backend.

**EAS upload-key SHA-1** (already have this from the preview APK; the Play upload-key SHA-1
should match it):
```
B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B
```

The upload key signs the bundle submitted to Play; it is **not** the certificate on the app users
install from Play. The EAS SHA registration is useful for directly installed preview APKs, while
the Play App Signing SHA registration is mandatory for internal/closed/production Play installs.

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
