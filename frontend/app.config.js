// Keep Firebase's client configuration outside the repository/build until it is supplied as an
// EAS file environment variable. app.base.json remains the readable source of truth for all other Expo
// settings; this layer adds android.googleServicesFile only when the real file exists in the build.
const base = require('./app.base.json');
const { Buffer } = require('buffer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
const googleClientIdSuffix = '.apps.googleusercontent.com';

// Nitro's Expo plugin needs the reversed iOS OAuth client ID even though Android uses Credential
// Manager and receives the Web client ID at runtime. OAuth client IDs are public identifiers, not
// secrets. Keep the plugin conditional so web-only builds do not require an unused iOS variable.
let googleIosUrlScheme;
if (googleIosClientId) {
  if (!googleIosClientId.endsWith(googleClientIdSuffix)) {
    throw new Error(
      'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID must be an iOS OAuth client ID ending in ' +
      googleClientIdSuffix,
    );
  }
  googleIosUrlScheme = `com.googleusercontent.apps.${googleIosClientId.slice(
    0,
    -googleClientIdSuffix.length,
  )}`;
}
const notificationIconBase64 = fs.readFileSync(
  path.join(path.dirname(require.resolve('./app.base.json')), 'assets/images/notification-icon.base64'),
  'utf8',
).trim();
const notificationIconHash = crypto
  .createHash('sha256')
  .update(notificationIconBase64)
  .digest('hex')
  .slice(0, 12);
const notificationIcon = path.join(
  os.tmpdir(), `trip-splitter-notification-${notificationIconHash}.png`,
);
if (!fs.existsSync(notificationIcon)) {
  fs.writeFileSync(notificationIcon, Buffer.from(notificationIconBase64, 'base64'));
}

const plugins = base.expo.plugins.map((plugin) => {
  if (!Array.isArray(plugin) || plugin[0] !== 'expo-notifications') return plugin;
  return [plugin[0], { ...plugin[1], icon: notificationIcon }];
});

if (googleIosUrlScheme) {
  plugins.push([
    'react-native-nitro-google-signin',
    { iosUrlScheme: googleIosUrlScheme },
  ]);
}

module.exports = {
  ...base,
  expo: {
    ...base.expo,
    plugins,
    android: {
      ...base.expo.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  },
};
