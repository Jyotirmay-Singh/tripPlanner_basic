const { withAndroidManifest } = require('@expo/config-plugins');

// The disposable USB-forwarded QA build points at http://127.0.0.1:8000.
// Expo does not map android.usesCleartextTraffic from app config into the manifest.
module.exports = function withQaLocalHttp(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application?.$) {
      throw new Error('Android application manifest entry is missing');
    }
    application.$['android:usesCleartextTraffic'] = 'true';
    return modConfig;
  });
};
