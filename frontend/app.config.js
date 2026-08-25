// Keep Firebase's client configuration outside the repository/build until it is supplied as an
// EAS file environment variable. app.json remains the readable source of truth for all other Expo
// settings; this layer adds android.googleServicesFile only when the real file exists in the build.
const base = require('./app.json');
const { Buffer } = require('buffer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
const notificationIconBase64 = fs.readFileSync(
  path.join(path.dirname(require.resolve('./app.json')), 'assets/images/notification-icon.base64'),
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
