import { requireOptionalNativeModule } from 'expo-modules-core';

export type UpiAppId = 'google-pay' | 'phonepe' | 'paytm' | 'bhim';

/** The complete JavaScript surface of the local Android module. */
export type UpiAppLauncherModule = {
  getAvailableUpiApps(): Promise<UpiAppId[]>;
  launchUpiApp(appId: UpiAppId): Promise<void>;
};

let cachedModule: UpiAppLauncherModule | null | undefined;

/** Optional by design: Expo Go, web and stale native builds must degrade to copy-only. */
export function getUpiAppLauncherModule(): UpiAppLauncherModule | null {
  if (cachedModule === undefined) {
    cachedModule = requireOptionalNativeModule<UpiAppLauncherModule>('UpiAppLauncher');
  }
  return cachedModule;
}
