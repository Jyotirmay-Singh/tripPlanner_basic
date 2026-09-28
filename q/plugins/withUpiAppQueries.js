const { withAndroidManifest } = require('@expo/config-plugins');

const UPI_PACKAGES = [
  'com.google.android.apps.nbu.paisa.user',
  'com.phonepe.app',
  'net.one97.paytm',
  'in.org.npci.upiapp',
];

function addUpiQueriesToManifest(manifest) {
  const queries = manifest.queries ?? [];
    const existing = new Set(
      queries.flatMap((query) => (query.package ?? []))
        .map((entry) => entry?.$?.['android:name'])
        .filter(Boolean),
    );
    const target = queries[0] ?? { $: {} };
    target.package = target.package ?? [];
    for (const packageName of UPI_PACKAGES) {
      if (!existing.has(packageName)) {
        target.package.push({ $: { 'android:name': packageName } });
        existing.add(packageName);
      }
    }
    if (queries.length === 0) queries.push(target);
    manifest.queries = queries;
  return manifest;
}

/** Add only the package visibility needed for the fixed external UPI launcher catalog. */
function withUpiAppQueries(config) {
  return withAndroidManifest(config, (modConfig) => {
    addUpiQueriesToManifest(modConfig.modResults.manifest);
    return modConfig;
  });
}

module.exports = withUpiAppQueries;
module.exports.UPI_PACKAGES = UPI_PACKAGES;
module.exports.addUpiQueriesToManifest = addUpiQueriesToManifest;
