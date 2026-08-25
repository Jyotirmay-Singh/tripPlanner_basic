import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useRouter, useSegments, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';

import { useAuth } from './AuthContext';
import { notificationHref } from './notificationRouting';
import { syncPushRegistrationIfEligible } from './pushNotifications';


export default function PushNotificationCoordinator() {
  const { user } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const inTripRoute = segments[0] === 'trip';
  const firstSegment = segments[0];
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const handledNotificationIds = useRef(new Set<string>());
  const userId = user?.id;

  const acceptResponse = useCallback((response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const identifier = response.notification.request.identifier;
    if (handledNotificationIds.current.has(identifier)) return;
    handledNotificationIds.current.add(identifier);
    const href = notificationHref(response.notification.request.content.data);
    if (href) setPendingHref(href);
    Notifications.clearLastNotificationResponse();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    acceptResponse(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(acceptResponse);
    return () => subscription.remove();
  }, [acceptResponse]);

  // A login may complete while the auth route is still mounted. Let the root auth guard reset that
  // stack first, then apply the saved notification destination without losing a cold-start tap.
  useEffect(() => {
    if (Platform.OS !== 'android' || !userId || !pendingHref || firstSegment === '(auth)') return;
    router.push(pendingHref as Href);
    setPendingHref(null);
  }, [firstSegment, pendingHref, router, userId]);

  // On sign-in, check whether the account already has trips. The boolean trip-route dependency also
  // catches the first successful create/join for accounts whose initial trip list was empty.
  useEffect(() => {
    if (Platform.OS !== 'android' || !userId) return;
    void syncPushRegistrationIfEligible({ allowPermissionPrompt: true });
  }, [inTripRoute, userId]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !userId) return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void syncPushRegistrationIfEligible({ allowPermissionPrompt: true });
      }
    });
    return () => subscription.remove();
  }, [userId]);

  return null;
}
