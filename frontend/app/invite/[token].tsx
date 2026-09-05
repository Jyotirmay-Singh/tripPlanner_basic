import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ApiError, getPublicTripInvite, type PublicTripInvite } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import T from '../../src/T';
import { Button, Icon } from '../../src/ui';
import {
  DEFAULT_APP_ORIGIN,
  invitePath,
  joinHref,
  passwordSetupHref,
  postAuthHref,
} from '../../src/inviteNavigation';
import {
  claimInviteApkAutoDownload,
  INVITE_APK_AUTO_DOWNLOAD_DELAY_MS,
  isAndroidWebBrowser,
} from '../../src/inviteAutoDownload';
import { CONTENT_MAX_WIDTH, FONTS, RADIUS, SPACING } from '../../src/theme';


type LandingFailure = 'invalid' | 'expired' | 'revoked' | 'disabled' | 'offline';

const failureCopy: Record<LandingFailure, { title: string; body: string }> = {
  invalid: {
    title: 'This invite is not valid',
    body: 'Check that the complete link was opened, or ask a trip admin to share a new one.',
  },
  expired: {
    title: 'This invite has expired',
    body: 'Invite links last seven days. Ask a trip admin to create a new link.',
  },
  revoked: {
    title: 'This invite is no longer active',
    body: 'A trip admin revoked this link. Ask them to share a new invitation.',
  },
  disabled: {
    title: 'Invite links are temporarily unavailable',
    body: 'Try again later, or ask the organizer for the six-character trip code.',
  },
  offline: {
    title: 'Could not check this invite',
    body: 'Check your internet connection and try again.',
  },
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function formattedExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'within seven days';
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function InviteLanding() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = firstParam(params.token).trim();
  const path = invitePath(token);
  const router = useRouter();
  const { colors } = useTheme();
  const {
    user, rememberInvite, clearPendingInvite,
  } = useAuth();
  const [invite, setInvite] = useState<PublicTripInvite | null>(null);
  const [failure, setFailure] = useState<LandingFailure | null>(path ? null : 'invalid');
  const [loading, setLoading] = useState(!!path);
  const [retryKey, setRetryKey] = useState(0);
  const [openAppError, setOpenAppError] = useState(false);
  const [autoDownloadFailed, setAutoDownloadFailed] = useState(false);
  const active = !!invite && !failure;
  const androidWebBrowser = isAndroidWebBrowser(
    Platform.OS,
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
  );

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    void (async () => {
      // Persist before validating so authentication/account setup cannot lose the route. Permanent
      // failures are removed below; temporary network/rollout failures remain retryable.
      try { await rememberInvite(path); } catch { /* Continue without persistence. */ }
      try {
        const result = await getPublicTripInvite(token);
        if (cancelled) return;
        if (result.status === 'active') {
          setInvite(result);
        } else {
          setInvite(null);
          setFailure(result.status);
          await clearPendingInvite();
        }
      } catch (error: unknown) {
        if (cancelled) return;
        const code = error instanceof ApiError ? error.detailCode : undefined;
        const permanentFailure = code === 'invite_expired' || code === 'invite_revoked'
          || code === 'invite_invalid';
        if (code === 'invite_expired') setFailure('expired');
        else if (code === 'invite_revoked') setFailure('revoked');
        else if (code === 'invite_disabled') setFailure('disabled');
        else if (code === 'invite_invalid') setFailure('invalid');
        else setFailure('offline');
        if (permanentFailure) await clearPendingInvite();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clearPendingInvite, path, rememberInvite, retryKey, token]);

  useEffect(() => {
    if (Platform.OS === 'web' || !invite || !user) return;
    if (user.credentials_set === false) {
      router.replace(passwordSetupHref(path));
      return;
    }
    const href = joinHref(token);
    if (href) router.replace(href);
  }, [invite, path, router, token, user]);

  useEffect(() => {
    if (!active || !androidWebBrowser) return undefined;
    let storage: Storage | null = null;
    try {
      storage = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      storage = null;
    }
    if (!claimInviteApkAutoDownload(token, storage)) return undefined;

    const timer = setTimeout(() => {
      void Linking.openURL(`${DEFAULT_APP_ORIGIN}/download/android`)
        .catch(() => setAutoDownloadFailed(true));
    }, INVITE_APK_AUTO_DOWNLOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, androidWebBrowser, token]);

  const signIn = () => {
    if (!path) return;
    void rememberInvite(path).then(() => {
      router.push({ pathname: '/(auth)/login', params: { returnTo: path } });
    });
  };

  const register = () => {
    if (!path) return;
    void rememberInvite(path).then(() => {
      router.push({ pathname: '/(auth)/register', params: { returnTo: path } });
    });
  };

  const continueOnWeb = () => {
    if (!path) return;
    if (!user) signIn();
    else if (user.credentials_set === false) {
      router.replace(passwordSetupHref(path));
    } else {
      const href = joinHref(token);
      if (href) router.replace(href);
    }
  };

  const openApp = () => {
    setOpenAppError(false);
    void Linking.openURL(`tripsplitter:///invite/${encodeURIComponent(token)}`)
      .catch(() => setOpenAppError(true));
  };

  const downloadApp = () => {
    void Linking.openURL(`${DEFAULT_APP_ORIGIN}/download/android`);
  };

  const dismiss = () => {
    void clearPendingInvite().finally(() => {
      router.replace(user ? postAuthHref(null) : '/(auth)/login');
    });
  };

  const problem = failure ? failureCopy[failure] : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.shell}>
          <Image
            source={require('../../assets/images/wordmark.png')}
            style={styles.wordmark}
            resizeMode="contain"
            accessibilityLabel="Trip Splitter"
          />

          <View style={[styles.pass, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.routeRail, { backgroundColor: colors.surfaceMuted }]}>
              <View style={[styles.routeDot, { backgroundColor: colors.primary }]} />
              <View style={[styles.routeLine, { backgroundColor: colors.primary }]} />
              <View style={[styles.routeDot, { backgroundColor: colors.primary }]} />
            </View>

            <View style={styles.passContent}>
              {loading || user === undefined ? (
                <View style={styles.loading} testID="invite-loading">
                  <ActivityIndicator color={colors.primary} />
                  <T muted>Checking your invitation…</T>
                </View>
              ) : active ? (
                <>
                  <View style={[styles.iconTile, { backgroundColor: colors.surfaceMuted }]}>
                    <Icon name="plane" size={25} color={colors.primary} />
                  </View>
                  <T variant="h1" testID="invite-trip-name">Join {invite.trip_name}</T>
                  <T muted>
                    Your place in this trip is ready to confirm. We’ll match you with the right
                    person or ask an admin to approve your request.
                  </T>
                  <View style={[styles.expiry, { borderColor: colors.border }]}>
                    <Icon name="clock" size={17} color={colors.textMuted} />
                    <T variant="caption" muted>Link active until {formattedExpiry(invite.expires_at)}</T>
                  </View>

                  {Platform.OS === 'web' ? (
                    <View style={styles.actions}>
                      <Button
                        label="Open Trip Splitter"
                        icon="plane"
                        onPress={openApp}
                        fullWidth
                        size="lg"
                        testID="invite-open-app"
                      />
                      {openAppError ? (
                        <T variant="caption" color={colors.danger} testID="invite-open-app-error">
                          This browser could not open the app. Download it below, or use Continue on web.
                        </T>
                      ) : null}
                      <Button
                        label="Download Android APK"
                        icon="download"
                        variant="secondary"
                        onPress={downloadApp}
                        fullWidth
                        testID="invite-download-apk"
                      />
                      {androidWebBrowser ? (
                        <T
                          variant="caption"
                          muted={!autoDownloadFailed}
                          color={autoDownloadFailed ? colors.danger : undefined}
                          testID="invite-auto-download-status"
                        >
                          {autoDownloadFailed
                            ? 'The automatic download was blocked. Tap Download Android APK.'
                            : 'The latest APK download will start automatically on this Android device.'}
                        </T>
                      ) : null}
                      <Button
                        label="Continue on web"
                        variant="ghost"
                        onPress={continueOnWeb}
                        fullWidth
                        testID="invite-continue-web"
                      />
                    </View>
                  ) : user ? (
                    <View style={styles.loading}>
                      <ActivityIndicator color={colors.primary} />
                      <T muted>Opening the join page…</T>
                    </View>
                  ) : (
                    <View style={styles.actions}>
                      <Button label="Sign in to continue" icon="lock" onPress={signIn} fullWidth size="lg" testID="invite-sign-in" />
                      <Button label="Create an account" variant="secondary" onPress={register} fullWidth testID="invite-register" />
                    </View>
                  )}
                </>
              ) : (
                <>
                  <View style={[styles.iconTile, { backgroundColor: colors.surfaceMuted }]}>
                    <Icon name={failure === 'offline' ? 'retry' : 'alert'} size={25} color={colors.primary} />
                  </View>
                  <T variant="h1" testID="invite-error-title">{problem?.title}</T>
                  <T muted>{problem?.body}</T>
                  <View style={styles.actions}>
                    {failure === 'offline' ? (
                      <Button label="Try again" icon="retry" onPress={() => setRetryKey((value) => value + 1)} fullWidth />
                    ) : null}
                    {Platform.OS === 'web' ? (
                      <Button label="Download Trip Splitter" icon="download" variant="secondary" onPress={downloadApp} fullWidth />
                    ) : null}
                  </View>
                </>
              )}
            </View>
          </View>

          {Platform.OS === 'web' && active ? (
            <View style={styles.installNote}>
              <T variant="h4">Installing for the first time?</T>
              <T variant="caption" muted>
                Download and install the APK. Then return to WhatsApp and tap the original invite
                link again; Trip Splitter will open directly on the joining page.
              </T>
            </View>
          ) : null}

          <Button label="Not now" variant="ghost" onPress={dismiss} haptic={false} />
          <T variant="caption" muted style={styles.privacy}>
            This private link expires automatically. Do not forward it outside your trip group.
          </T>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { flexGrow: 1, padding: SPACING.lg, justifyContent: 'center', alignItems: 'center' },
  shell: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.lg, alignItems: 'flex-start' },
  wordmark: { width: 178, height: 48 },
  pass: {
    width: '100%', minHeight: 390, borderWidth: 1, borderRadius: RADIUS.xl,
    flexDirection: 'row', overflow: 'hidden',
  },
  routeRail: { width: 48, alignItems: 'center', paddingVertical: SPACING.xl },
  routeDot: { width: 12, height: 12, borderRadius: 6 },
  routeLine: { width: 2, flex: 1, opacity: 0.42 },
  passContent: { flex: 1, minWidth: 0, padding: SPACING.xl, gap: SPACING.md },
  iconTile: {
    width: 48, height: 48, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center',
  },
  expiry: {
    minHeight: 46, borderTopWidth: 1, borderBottomWidth: 1, flexDirection: 'row',
    alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.sm,
  },
  actions: { gap: SPACING.sm, marginTop: SPACING.sm },
  loading: { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  installNote: { maxWidth: 520, gap: SPACING.xs, paddingLeft: 48 },
  privacy: { maxWidth: 520, paddingLeft: 48, fontFamily: FONTS.body },
});
