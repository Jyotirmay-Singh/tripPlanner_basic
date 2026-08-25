# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Android push notification setup

The app uses `expo-notifications`; delivery remains disabled in the backend until these one-time
credentials are configured:

1. In Firebase, register Android package `com.tripsplitter.app` and download `google-services.json`.
2. Add that file as an EAS **file** environment variable named `GOOGLE_SERVICES_JSON` in both the
   `preview` and `production` environments. `app.config.js` maps it to
   `android.googleServicesFile`; the local file is intentionally gitignored.
3. Create an FCM v1 service account in Firebase/Google Cloud and upload its JSON through
   `eas credentials --platform android`. Never add the service-account file to this repository.
4. Enable enhanced push security in the Expo project, create an Expo access token, and add it to
   Render as `EXPO_PUSH_ACCESS_TOKEN`.
5. Deploy the backend with `PUSH_NOTIFICATIONS_ENABLED=true`, then rebuild the preview APK and the
   production AAB. Android remote push cannot be tested in Expo Go on SDK 54; use a physical device
   with the preview build.

Expo Push Service and FCM are free for this application's expected volume. The backend reuses
MongoDB and the existing Render process, so no Redis, queue service, or additional worker is needed.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
