import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS, SHADOW, MOTION } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';

export type ToastType = 'success' | 'error' | 'info';
type ToastState = { message: string; type: ToastType } | null;

type Ctx = { show: (message: string, type?: ToastType, durationMs?: number) => void };
const ToastCtx = createContext<Ctx>({ show: () => {} });
export const useToast = () => useContext(ToastCtx);

const ICONS: Record<ToastType, IconName> = { success: 'check-circle', error: 'alert', info: 'info' };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState>(null);
  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: -120, duration: MOTION.base, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(opacity, { toValue: 0, duration: MOTION.base, useNativeDriver: Platform.OS !== 'web' }),
    ]).start(() => setToast(null));
  }, [translateY, opacity]);

  const show = useCallback((message: string, type: ToastType = 'info', durationMs = 3200) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, type });
    translateY.setValue(-120);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: Platform.OS !== 'web', damping: 18, stiffness: 200 }),
      Animated.timing(opacity, { toValue: 1, duration: MOTION.base, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
    timer.current = setTimeout(hide, durationMs);
  }, [hide, translateY, opacity]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const accent = toast
    ? toast.type === 'success' ? colors.success : toast.type === 'error' ? colors.danger : colors.primary
    : colors.primary;

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { paddingTop: insets.top + SPACING.sm }]}>
          <Animated.View
            accessibilityLiveRegion="polite"
            style={[
              styles.toast, SHADOW.card,
              { backgroundColor: colors.surface, borderColor: colors.border, opacity, transform: [{ translateY }] },
            ]}
          >
            <View style={[styles.dot, { backgroundColor: accent + '22' }]}>
              <Icon name={ICONS[toast.type]} size={18} color={accent} />
            </View>
            <T style={{ flex: 1 }} numberOfLines={3}>{toast.message}</T>
          </Animated.View>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}

const styles = StyleSheet.create({
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginHorizontal: SPACING.lg, padding: SPACING.md,
    borderRadius: RADIUS.md, borderWidth: 1,
  },
  dot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
});
