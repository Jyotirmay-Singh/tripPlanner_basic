const { withAndroidManifest } = require('expo/config-plugins');

// Android 7–9 requires write permission for gallery saving. Android 10+ uses MediaStore.
module.exports = function withReceiptPermissions(config) {
  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];
    let legacyWrite = permissions.find((entry) => entry.$['android:name'] === 'android.permission.WRITE_EXTERNAL_STORAGE');
    if (!legacyWrite) {
      legacyWrite = { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE' } };
      permissions.push(legacyWrite);
    }
    legacyWrite.$['android:maxSdkVersion'] = '28';
    manifest['uses-permission'] = permissions;
    return result;
  });
};
