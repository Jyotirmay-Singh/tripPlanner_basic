# Trip Splitter 1.0.0 — Android release 19

Source: `dd7590c98e5ccf3c9c625d39b726b882049cb14d` ([commit](https://github.com/Jyotirmay-Singh/tripPlanner_basic/commit/dd7590c98e5ccf3c9c625d39b726b882049cb14d)).
Expo SDK 54; package `com.tripsplitter.app`; EAS CLI 21.4.0.

Public release: <https://github.com/Jyotirmay-Singh/tripPlanner_basic/releases/tag/android-v1.0.0-build.19>.

| Artifact | Version code | EAS build ID | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| APK | 19 | `851f617f-6b0a-42bf-a093-ff0a6109063f` | 131,048,264 | `4c4e7ec81ce64285518a0c1fa54a9c369d6da3f84f1195eda4b9dfdac1f67dd4` |
| AAB | 20 | `1e2db35f-94a3-486b-9014-92e22d4ae912` | 94,135,799 | `d37a2369ff95551465a0ddc3ad7a60f106550de3393c2c162d7be1a21147d5ec` |

- APK: <https://tripsplitter-web.vercel.app/download/android>
- Local Play bundle: `.release-tmp/android-release-20261005/trip-splitter-android-1.0.0-build-20.aab` (not a public GitHub release asset).

The group code and private invitation share messages use the stable APK URL. Refreshing its
temporary redirect updates downloads from previously shared messages as well as new invitations.
GitHub release assets provide a durable destination after EAS build artifacts expire.

## Validation

- Expo dependency check and Expo Doctor: 17/17 checks passed.
- Frozen Yarn installation, TypeScript, ESLint, and production web export passed.
- Frontend: 1,153 tests passed across 130 suites.
- Backend: 1,024 offline tests passed, zero failures; dependency check passed.
- Production API health and production web homepage returned HTTP 200.
- Signed artifacts contain the intended production backend and Google Web client settings.
- Package, app version, incremented version codes, and Android target SDK verified from artifacts.
- APK signature verified; certificate matches the existing EAS release key.
- App bundle JAR signature and bundletool validation passed; certificate matches the existing EAS upload key.
- Every 64-bit native library supports 16 KB memory pages; APK ZIP alignment checked.
- App bundle requests 16 KB page alignment.

Signing SHA-1: `B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B`.
Signing SHA-256: `FD:89:4B:FB:EA:E5:99:D7:34:5C:40:DA:E9:13:80:CF:C1:5D:AE:6D:4D:58:B5:18:9D:68:18:81:FA:4F:D9:1C`.

## Remaining device and Play Console checks

No Android device or emulator was attached. Installation, cold launch, real authentication,
and in-app trip navigation were not tested on a device. Automated validation does not cover those flows.

The AAB has not been submitted to Google Play. After enabling Play App Signing, register its
app-signing SHA-1 with the Android OAuth client and its SHA-256 in the website App Links configuration.
The upload certificate above is separate from the certificate used on Play-installed apps.
See [the Play Console guide](../PLAY_INTERNAL_TESTING.md).
