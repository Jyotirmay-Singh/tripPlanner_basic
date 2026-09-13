/* global describe, expect, it */

const fs = require('fs');
const path = require('path');
const config = require('../../app.config.js');
const plugin = require('../../plugins/withUpiAppQueries');

const moduleConfigPath = require.resolve('../../modules/upi-app-launcher/expo-module.config.json');
const moduleRoot = path.dirname(moduleConfigPath);
const moduleConfig = require(moduleConfigPath);
const nativeSource = fs.readFileSync(path.join(
  moduleRoot,
  'android/src/main/java/com/tripsplitter/upilauncher/UpiAppLauncherModule.kt',
), 'utf8');

describe('Android UPI package visibility configuration', () => {
  it('registers the local Expo config plugin', () => {
    expect(config.expo.plugins).toContain('./plugins/withUpiAppQueries');
  });

  it('adds exactly four unique catalog packages and remains idempotent', () => {
    const manifest = { $: {} };
    plugin.addUpiQueriesToManifest(manifest);
    plugin.addUpiQueriesToManifest(manifest);

    const names = manifest.queries.flatMap((query) => query.package ?? [])
      .map((entry) => entry.$['android:name']);
    expect(names).toEqual(plugin.UPI_PACKAGES);
    expect(new Set(names).size).toBe(4);
  });

  it('autolinks one Android-only local module with only discovery and allowlisted launch methods', () => {
    expect(moduleConfig).toEqual({
      platforms: ['android'],
      android: {
        modules: ['com.tripsplitter.upilauncher.UpiAppLauncherModule'],
      },
    });
    const functionNames = [...nativeSource.matchAll(/AsyncFunction\("([^"]+)"\)/g)]
      .map((match) => match[1]);
    expect(functionNames).toEqual(['getAvailableUpiApps', 'launchUpiApp']);
    expect(nativeSource).toContain('launchUpiApp") { appId: String ->');
    expect(nativeSource).toContain('getLaunchIntentForPackage(packageName)');
    expect(nativeSource).not.toMatch(/upi:\/\/pay|payee|merchant|amount|upiId/i);
  });

  it('keeps the manifest visibility list and native hardcoded allowlist in sync', () => {
    const nativePackages = [...nativeSource.matchAll(/to "([^"]+)"/g)]
      .map((match) => match[1]);
    expect(nativePackages).toEqual(plugin.UPI_PACKAGES);
  });
});
