// Minimal jest setup for unit-testing pure modules (e.g. src/permissions.ts).
// jest-expo's babel transform handles TS/JSX consistently with the app.
module.exports = {
  preset: 'jest-expo',
  // Unit tests run without a native Firebase/notification runtime. Resolve the app's explicit
  // platform seams to their no-op implementations; native behavior is covered through pure
  // routing tests and TypeScript/native-build validation.
  moduleNameMapper: {
    '^(.*/)?pushNotifications$': '<rootDir>/src/pushNotificationsFallback.ts',
    '^(.*/)?NotificationSettingsRow$': '<rootDir>/src/NotificationSettingsRow.tsx',
    '^(.*/)?PushNotificationCoordinator$': '<rootDir>/src/PushNotificationCoordinator.tsx',
  },
};
