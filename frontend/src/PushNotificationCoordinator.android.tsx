import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useRouter, useSegments, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';

import { api } from './api';
import { useAuth } from './AuthContext';
import {
  notificationHref,
  parseNotificationRouteData,
  type ParsedNotificationRouteData,
} from './notificationRouting';
import { syncPushRegistrationIfEligible } from './pushNotifications';


function pushDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  // Payload identifiers and state names are safe; never pass raw errors, tokens, or message text.
  console.info(`[push-notifications] ${event}`, data);
}


export default function PushNotificationCoordinator() {
  const { user, handleAuthenticationRequired } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const inTripRoute = segments[0] === 'trip';
  const firstSegment = segments[0];
  const [pendingRoute, setPendingRoute] = useState<ParsedNotificationRouteData | null>(null);
  const [authorizationAttempt, setAuthorizationAttempt] = useState(0);
  const handledNotificationIds = useRef(new Set<string>());
  const handledEventKeys = useRef(new Set<string>());
  const userId = user?.id;

  const acceptResponse = useCallback((response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const identifier = response.notification.request.identifier;
    if (handledNotificationIds.current.has(identifier)) {
      pushDiagnostic('response_ignored', { reason: 'duplicate_notification_id' });
      return;
    }
    handledNotificationIds.current.add(identifier);

    const parsed = parseNotificationRouteData(response.notification.request.content.data);
    if (!parsed) {
      pushDiagnostic('response_ignored', { reason: 'invalid_payload' });
      Notifications.clearLastNotificationResponse();
      return;
    }
    if (handledEventKeys.current.has(parsed.eventKey)) {
      pushDiagnostic('response_ignored', {
        reason: 'duplicate_event_key', eventKey: parsed.eventKey,
      });
      Notifications.clearLastNotificationResponse();
      return;
    }
    handledEventKeys.current.add(parsed.eventKey);
    setPendingRoute(parsed);
    pushDiagnostic('response_accepted', {
      eventKey: parsed.eventKey, tripId: parsed.tripId, appState: AppState.currentState,
    });
    Notifications.clearLastNotificationResponse();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    acceptResponse(Notifications.getLastNotificationResponse());
    const responseSubscription = Notifications.addNotificationResponseReceivedListener(acceptResponse);
    const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
      const parsed = parseNotificationRouteData(notification.request.content.data);
      pushDiagnostic(parsed ? 'notification_received' : 'notification_received_invalid', {
        ...(parsed ? { eventKey: parsed.eventKey, tripId: parsed.tripId } : {}),
        appState: AppState.currentState,
      });
    });
    return () => {
      responseSubscription.remove();
      receivedSubscription.remove();
    };
  }, [acceptResponse]);

  // A login may complete while the auth route is still mounted. Let the root auth guard reset that
  // stack, then verify current trip access before following a saved notification destination.
  useEffect(() => {
    if (Platform.OS !== 'android' || !userId || !pendingRoute || firstSegment === '(auth)') return;
    const href = notificationHref(pendingRoute);
    if (!href) {
      setPendingRoute(null);
      return;
    }
    let cancelled = false;
    api(`/trips/${pendingRoute.tripId}`)
      .then(() => {
        if (cancelled) return;
        router.push(href as Href);
        pushDiagnostic('navigation_completed', {
          eventKey: pendingRoute.eventKey, tripId: pendingRoute.tripId,
        });
        setPendingRoute((current) => (
          current?.eventKey === pendingRoute.eventKey ? null : current
        ));
      })
      .catch((error: { status?: number }) => {
        if (cancelled) return;
        if (error?.status === 401) {
          pushDiagnostic('navigation_deferred', {
            eventKey: pendingRoute.eventKey, reason: 'authentication_required',
          });
          void handleAuthenticationRequired();
          return;
        }
        if (error?.status === 403 || error?.status === 404) {
          pushDiagnostic('navigation_rejected', {
            eventKey: pendingRoute.eventKey, reason: 'trip_access_removed',
          });
          setPendingRoute(null);
          return;
        }
        // Preserve the destination across a transient offline/server failure. Returning to the
        // foreground increments authorizationAttempt and retries the existing authenticated API.
        pushDiagnostic('navigation_deferred', {
          eventKey: pendingRoute.eventKey, reason: 'trip_check_unavailable',
        });
      });
    return () => { cancelled = true; };
  }, [
    authorizationAttempt, firstSegment, handleAuthenticationRequired,
    pendingRoute, router, userId,
  ]);

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
        setAuthorizationAttempt((attempt) => attempt + 1);
        void syncPushRegistrationIfEligible({ allowPermissionPrompt: true });
      }
    });
    return () => subscription.remove();
  }, [userId]);

  return null;
}
