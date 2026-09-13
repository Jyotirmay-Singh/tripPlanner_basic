import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';
import {
  getUpiAppLauncherModule,
  type UpiAppId,
  type UpiAppLauncherModule,
} from './upiAppLauncherModule';

export type { UpiAppId } from './upiAppLauncherModule';

export type UpiApp = Readonly<{
  id: UpiAppId;
  label: string;
  packageName: string;
}>;

/** Fixed product catalog and priority order. Only each allowlisted id crosses the native bridge. */
export const UPI_APP_CATALOG: readonly UpiApp[] = Object.freeze([
  {
    id: 'google-pay',
    label: 'Google Pay',
    packageName: 'com.google.android.apps.nbu.paisa.user',
  },
  {
    id: 'phonepe',
    label: 'PhonePe',
    packageName: 'com.phonepe.app',
  },
  {
    id: 'paytm',
    label: 'Paytm',
    packageName: 'net.one97.paytm',
  },
  {
    id: 'bhim',
    label: 'BHIM',
    packageName: 'in.org.npci.upiapp',
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
      status:
        | 'clipboard_failed'
        | 'unavailable_app'
        | 'launch_failed'
        | 'module_unavailable'
        | 'unsupported_platform';
      message: string;
      copied: boolean;
      app?: UpiApp;
    };

type SetClipboard = (value: string) => Promise<boolean>;

export async function discoverUpiApps(
  platform = Platform.OS,
  module?: UpiAppLauncherModule | null,
): Promise<UpiAvailability> {
  if (platform !== 'android') {
    return { status: 'unsupported', platform, apps: [] };
  }
  const nativeModule = module === undefined ? getUpiAppLauncherModule() : module;
  if (!nativeModule) {
    return { status: 'discovery_failed', platform, apps: [] };
  }
  try {
    const availableIds = new Set(await nativeModule.getAvailableUpiApps());
    const apps = UPI_APP_CATALOG.filter((app) => availableIds.has(app.id));
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
  module?: UpiAppLauncherModule | null,
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
  const nativeModule = module === undefined ? getUpiAppLauncherModule() : module;
  if (!nativeModule) {
    return {
      ok: false,
      status: 'module_unavailable',
      message: 'UPI app launching is unavailable in this build. The UPI ID was copied.',
      copied: true,
      app,
    };
  }
  try {
    const availableIds = await nativeModule.getAvailableUpiApps();
    if (!availableIds.includes(app.id)) {
      return {
        ok: false,
        status: 'unavailable_app',
        message: `${app.label} is no longer available. The UPI ID was copied.`,
        copied: true,
        app,
      };
    }
  } catch {
    return {
      ok: false,
      status: 'launch_failed',
      message: `Could not check ${app.label}. The UPI ID was copied.`,
      copied: true,
      app,
    };
  }
  try {
    await nativeModule.launchUpiApp(app.id);
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
    module?: UpiAppLauncherModule | null;
  } = {},
): Promise<UpiLaunchResult> {
  const copied = await copyUpiId(upiId, dependencies.setStringAsync ?? Clipboard.setStringAsync);
  if (!copied.ok) return { ...copied, copied: false };
  return launchUpiApp(
    app,
    dependencies.platform ?? Platform.OS,
    dependencies.module,
  );
}
