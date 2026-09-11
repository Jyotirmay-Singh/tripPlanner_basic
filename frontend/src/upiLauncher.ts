import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

export type UpiAppId = 'google-pay' | 'phonepe' | 'paytm' | 'bhim';

export type UpiApp = Readonly<{
  id: UpiAppId;
  label: string;
  packageName: string;
  launchUri: string;
}>;

const packageLaunchUri = (packageName: string) => (
  `intent://#Intent;action=android.intent.action.MAIN;`
  + `category=android.intent.category.LAUNCHER;package=${packageName};end`
);

/** Fixed product catalog and priority order. These intents carry no payment data. */
export const UPI_APP_CATALOG: readonly UpiApp[] = Object.freeze([
  {
    id: 'google-pay',
    label: 'Google Pay',
    packageName: 'com.google.android.apps.nbu.paisa.user',
    launchUri: packageLaunchUri('com.google.android.apps.nbu.paisa.user'),
  },
  {
    id: 'phonepe',
    label: 'PhonePe',
    packageName: 'com.phonepe.app',
    launchUri: packageLaunchUri('com.phonepe.app'),
  },
  {
    id: 'paytm',
    label: 'Paytm',
    packageName: 'net.one97.paytm',
    launchUri: packageLaunchUri('net.one97.paytm'),
  },
  {
    id: 'bhim',
    label: 'BHIM',
    packageName: 'in.org.npci.upiapp',
    launchUri: packageLaunchUri('in.org.npci.upiapp'),
  },
]);

export type UpiAvailability = {
  status: 'available' | 'none' | 'discovery_failed' | 'unsupported';
  platform: string;
  apps: UpiApp[];
};

export type UpiCopyResult =
  | { ok: true; status: 'copied' }
  | { ok: false; status: 'clipboard_failed'; message: string };

export type UpiLaunchResult =
  | { ok: true; status: 'launched'; app: UpiApp; copied: true }
  | {
      ok: false;
      status: 'clipboard_failed' | 'unavailable_app' | 'launch_failed' | 'unsupported_platform';
      message: string;
      copied: boolean;
      app?: UpiApp;
    };

type CanOpenUrl = (url: string) => Promise<boolean>;
type OpenUrl = (url: string) => Promise<unknown>;
type SetClipboard = (value: string) => Promise<boolean>;

export async function discoverUpiApps(
  platform = Platform.OS,
  canOpenURL: CanOpenUrl = Linking.canOpenURL,
): Promise<UpiAvailability> {
  if (platform !== 'android') {
    return { status: 'unsupported', platform, apps: [] };
  }
  try {
    const detected = await Promise.all(
      UPI_APP_CATALOG.map(async (app) => ({ app, installed: await canOpenURL(app.launchUri) })),
    );
    const apps = detected.filter(({ installed }) => installed).map(({ app }) => app);
    return { status: apps.length ? 'available' : 'none', platform, apps };
  } catch {
    // Android package visibility or Linking failures must degrade to copy-only, never guess.
    return { status: 'discovery_failed', platform, apps: [] };
  }
}

export async function copyUpiId(
  upiId: string,
  setStringAsync: SetClipboard = Clipboard.setStringAsync,
): Promise<UpiCopyResult> {
  try {
    const copied = await setStringAsync(upiId);
    if (copied === false) {
      return {
        ok: false,
        status: 'clipboard_failed',
        message: 'Could not copy the UPI ID. Try again.',
      };
    }
    return { ok: true, status: 'copied' };
  } catch {
    return {
      ok: false,
      status: 'clipboard_failed',
      message: 'Could not copy the UPI ID. Try again.',
    };
  }
}

async function launchUpiApp(
  app: UpiApp,
  platform: string,
  canOpenURL: CanOpenUrl,
  openURL: OpenUrl,
): Promise<UpiLaunchResult> {
  if (platform !== 'android') {
    return {
      ok: false,
      status: 'unsupported_platform',
      message: 'UPI app launching is available only on Android.',
      copied: true,
      app,
    };
  }
  let available = false;
  try {
    available = await canOpenURL(app.launchUri);
  } catch {
    available = false;
  }
  if (!available) {
    return {
      ok: false,
      status: 'unavailable_app',
      message: `${app.label} is no longer available. The UPI ID was copied.`,
      copied: true,
      app,
    };
  }
  try {
    const opened = await openURL(app.launchUri);
    if (opened === false) throw new Error('Linking resolved false');
    return { ok: true, status: 'launched', app, copied: true };
  } catch {
    return {
      ok: false,
      status: 'launch_failed',
      message: `Could not open ${app.label}. The UPI ID was copied.`,
      copied: true,
      app,
    };
  }
}

/** Enforce the safety ordering: a failed clipboard write can never be followed by an app launch. */
export async function copyAndLaunchUpiApp(
  upiId: string,
  app: UpiApp,
  dependencies: {
    platform?: string;
    setStringAsync?: SetClipboard;
    canOpenURL?: CanOpenUrl;
    openURL?: OpenUrl;
  } = {},
): Promise<UpiLaunchResult> {
  const copied = await copyUpiId(upiId, dependencies.setStringAsync ?? Clipboard.setStringAsync);
  if (!copied.ok) return { ...copied, copied: false };
  return launchUpiApp(
    app,
    dependencies.platform ?? Platform.OS,
    dependencies.canOpenURL ?? Linking.canOpenURL,
    dependencies.openURL ?? Linking.openURL,
  );
}
