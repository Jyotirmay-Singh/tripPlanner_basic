import {
  UPI_APP_CATALOG,
  copyAndLaunchUpiApp,
  copyUpiId,
  discoverUpiApps,
} from '../upiLauncher';

describe('UPI Android launcher catalog', () => {
  it('has the fixed unique priority order and only package-targeted non-payment intents', () => {
    expect(UPI_APP_CATALOG.map((app) => [app.label, app.packageName])).toEqual([
      ['Google Pay', 'com.google.android.apps.nbu.paisa.user'],
      ['PhonePe', 'com.phonepe.app'],
      ['Paytm', 'net.one97.paytm'],
      ['BHIM', 'in.org.npci.upiapp'],
    ]);
    expect(new Set(UPI_APP_CATALOG.map((app) => app.packageName)).size).toBe(4);
    for (const app of UPI_APP_CATALOG) {
      expect(app.launchUri).toContain(`package=${app.packageName}`);
      expect(app.launchUri).not.toMatch(/upi:\/\/pay|[?;&](pa|pn|am|cu|mc|tn|tr)=/i);
    }
  });

  it('filters to installed apps while retaining Google Pay priority', async () => {
    const installed = new Set([
      'com.google.android.apps.nbu.paisa.user',
      'net.one97.paytm',
    ]);
    const result = await discoverUpiApps('android', async (uri) => (
      [...installed].some((packageName) => uri.includes(`package=${packageName}`))
    ));

    expect(result.status).toBe('available');
    expect(result.apps.map((app) => app.id)).toEqual(['google-pay', 'paytm']);
  });

  it('uses copy-only results for no apps, discovery failure, web, and iOS', async () => {
    await expect(discoverUpiApps('android', async () => false)).resolves.toMatchObject({
      status: 'none', apps: [],
    });
    await expect(discoverUpiApps('android', async () => {
      throw new Error('package visibility failed');
    })).resolves.toMatchObject({ status: 'discovery_failed', apps: [] });
    await expect(discoverUpiApps('web', async () => true)).resolves.toMatchObject({
      status: 'unsupported', platform: 'web', apps: [],
    });
    await expect(discoverUpiApps('ios', async () => true)).resolves.toMatchObject({
      status: 'unsupported', platform: 'ios', apps: [],
    });
  });
});

describe('UPI clipboard and launch ordering', () => {
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

  it('never checks or launches an app after clipboard failure', async () => {
    const canOpenURL = jest.fn(async () => true);
    const openURL = jest.fn(async () => undefined);

    const result = await copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android',
      setStringAsync: async () => false,
      canOpenURL,
      openURL,
    });

    expect(result).toMatchObject({ ok: false, status: 'clipboard_failed', copied: false });
    expect(canOpenURL).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
  });

  it('reports unavailable, launch failure, unsupported platform, and success after copying', async () => {
    const copied = jest.fn(async () => true);
    const unavailableOpen = jest.fn(async () => undefined);
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied,
      canOpenURL: async () => false, openURL: unavailableOpen,
    })).resolves.toMatchObject({ status: 'unavailable_app', copied: true });
    expect(unavailableOpen).not.toHaveBeenCalled();

    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied,
      canOpenURL: async () => true, openURL: async () => false,
    })).resolves.toMatchObject({ status: 'launch_failed', copied: true });

    const iosOpen = jest.fn(async () => undefined);
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'ios', setStringAsync: copied,
      canOpenURL: async () => true, openURL: iosOpen,
    })).resolves.toMatchObject({ status: 'unsupported_platform', copied: true });
    expect(iosOpen).not.toHaveBeenCalled();

    const androidOpen = jest.fn(async () => undefined);
    await expect(copyAndLaunchUpiApp('person@upi', googlePay, {
      platform: 'android', setStringAsync: copied,
      canOpenURL: async () => true, openURL: androidOpen,
    })).resolves.toMatchObject({ ok: true, status: 'launched', copied: true });
    expect(androidOpen).toHaveBeenCalledWith(googlePay.launchUri);
  });
});
