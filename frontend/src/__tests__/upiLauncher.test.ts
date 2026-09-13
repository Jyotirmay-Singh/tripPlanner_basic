import {
  UPI_APP_CATALOG,
  copyAndLaunchUpiApp,
  copyUpiId,
  discoverUpiApps,
} from '../upiLauncher';
import type { UpiAppId, UpiAppLauncherModule } from '../upiAppLauncherModule';

const nativeModule = (
  available: UpiAppId[] = ['google-pay', 'phonepe', 'paytm', 'bhim'],
): jest.Mocked<UpiAppLauncherModule> => ({
  getAvailableUpiApps: jest.fn(async () => available),
  launchUpiApp: jest.fn(async (_appId: UpiAppId) => undefined),
});

describe('UPI Android launcher catalog', () => {
  it('has a fixed unique priority order and carries no payment fields or launch URLs', () => {
    expect(UPI_APP_CATALOG.map((app) => [app.id, app.label, app.packageName])).toEqual([
      ['google-pay', 'Google Pay', 'com.google.android.apps.nbu.paisa.user'],
      ['phonepe', 'PhonePe', 'com.phonepe.app'],
      ['paytm', 'Paytm', 'net.one97.paytm'],
      ['bhim', 'BHIM', 'in.org.npci.upiapp'],
    ]);
    expect(new Set(UPI_APP_CATALOG.map((app) => app.packageName)).size).toBe(4);
    expect(JSON.stringify(UPI_APP_CATALOG)).not.toMatch(
      /intent:\/\/|upi:\/\/pay|"(pa|pn|am|cu|mc|tn|tr)"/i,
    );
  });

  it('filters native discovery to known apps while retaining catalog priority', async () => {
    const module = nativeModule(['paytm', 'google-pay', 'google-pay']);

    const result = await discoverUpiApps('android', module);

    expect(result.status).toBe('available');
    expect(result.apps.map((app) => app.id)).toEqual(['google-pay', 'paytm']);
    expect(module.getAvailableUpiApps).toHaveBeenCalledTimes(1);
  });

  it('uses copy-only results for no apps, module/discovery failure, web, and iOS', async () => {
    await expect(discoverUpiApps('android', nativeModule([]))).resolves.toMatchObject({
      status: 'none', apps: [],
    });
    await expect(discoverUpiApps('android', null)).resolves.toMatchObject({
      status: 'discovery_failed', apps: [],
    });
    const failed = nativeModule();
    failed.getAvailableUpiApps.mockRejectedValueOnce(new Error('package query failed'));
    await expect(discoverUpiApps('android', failed)).resolves.toMatchObject({
      status: 'discovery_failed', apps: [],
    });
    await expect(discoverUpiApps('web', nativeModule())).resolves.toMatchObject({
      status: 'unsupported', platform: 'web', apps: [],
    });
    await expect(discoverUpiApps('ios', nativeModule())).resolves.toMatchObject({
      status: 'unsupported', platform: 'ios', apps: [],
    });
  });
});

describe('UPI clipboard and native launch ordering', () => {
  const googlePay = UPI_APP_CATALOG[0];

  it('distinguishes clipboard resolved-false and exception paths', async () => {
    await expect(copyUpiId('person@upi', async () => true)).resolves.toEqual({
      ok: true, status: 'copied',
    });
    await expect(copyUpiId('person@upi', async () => false)).resolves.toMatchObject({
      ok: false, status: 'clipboard_failed',
    });
    await expect(copyUpiId('person@upi', async () => {
      throw new Error('clipboard unavailable');
    })).resolves.toMatchObject({ ok: false, status: 'clipboard_failed' });
  });

  it('never queries or launches the native module after clipboard failure', async () => {
    const module = nativeModule();

    const result = await copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android',
      setStringAsync: async () => false,
      module,
    });

    expect(result).toMatchObject({ ok: false, status: 'clipboard_failed', copied: false });
    expect(module.getAvailableUpiApps).not.toHaveBeenCalled();
    expect(module.launchUpiApp).not.toHaveBeenCalled();
  });

  it('falls back after a missing module, removed app, discovery error, or launch error', async () => {
    const copied = jest.fn(async () => true);
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied, module: null,
    })).resolves.toMatchObject({ status: 'module_unavailable', copied: true });

    const removed = nativeModule(['phonepe']);
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied, module: removed,
    })).resolves.toMatchObject({ status: 'unavailable_app', copied: true });
    expect(removed.launchUpiApp).not.toHaveBeenCalled();

    const discoveryFailed = nativeModule();
    discoveryFailed.getAvailableUpiApps.mockRejectedValueOnce(new Error('query failed'));
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied, module: discoveryFailed,
    })).resolves.toMatchObject({ status: 'launch_failed', copied: true });
    expect(discoveryFailed.launchUpiApp).not.toHaveBeenCalled();

    const launchFailed = nativeModule();
    launchFailed.launchUpiApp.mockRejectedValueOnce(new Error('activity missing'));
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied, module: launchFailed,
    })).resolves.toMatchObject({ status: 'launch_failed', copied: true });
  });

  it('launches only the selected allowlisted id after a successful copy and fresh query', async () => {
    const copied = jest.fn(async () => true);
    const module = nativeModule();

    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied, module,
    })).resolves.toMatchObject({ ok: true, status: 'launched', copied: true });

    expect(copied).toHaveBeenCalledWith('person@upi');
    expect(module.getAvailableUpiApps).toHaveBeenCalledTimes(1);
    expect(module.launchUpiApp).toHaveBeenCalledWith('google-pay');
    expect(copied.mock.invocationCallOrder[0]).toBeLessThan(
      module.getAvailableUpiApps.mock.invocationCallOrder[0],
    );
    expect(module.getAvailableUpiApps.mock.invocationCallOrder[0]).toBeLessThan(
      module.launchUpiApp.mock.invocationCallOrder[0],
    );
  });

  it('does not invoke Android on unsupported platforms even after copying', async () => {
    const module = nativeModule();
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'ios', setStringAsync: async () => true, module,
    })).resolves.toMatchObject({ status: 'unsupported_platform', copied: true });
    expect(module.getAvailableUpiApps).not.toHaveBeenCalled();
    expect(module.launchUpiApp).not.toHaveBeenCalled();
  });
});
