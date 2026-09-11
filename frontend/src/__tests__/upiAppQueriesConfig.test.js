/* global describe, expect, it */

const config = require('../../app.config.js');
const plugin = require('../../plugins/withUpiAppQueries');

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
});
