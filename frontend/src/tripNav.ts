import type { Href } from 'expo-router';

// Pure trip-navigation helper, kept free of React/JSX so it can be unit-tested without a component
// renderer (mirrors src/authNav.ts).

export const TRIPS_TAB_HREF = '/(tabs)/trips' as Href;

type BackRouter = {
  canGoBack?: () => boolean;
  back: () => void;
  replace: (href: Href) => void;
};

/**
 * Header-back action for trip screens. Trip routes live in the ROOT stack, so the default back
 * button only appears when the stack has history — absent whenever a trip is reached WITHOUT a
 * back entry: `router.replace('/trip/[id]')` after create/join, or a deep-link / web-refresh
 * landing straight on the trip. This falls back to the Trips tab in that case, so a back affordance
 * is always present and always lands somewhere sane.
 */
export function goBackOrTrips(router: BackRouter): void {
  if (router.canGoBack?.()) router.back();
  else router.replace(TRIPS_TAB_HREF);
}
