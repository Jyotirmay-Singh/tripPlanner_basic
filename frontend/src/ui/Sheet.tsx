import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Modal, Animated, Pressable, View, StyleSheet, Platform, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS, SHADOW, MOTION, CONTENT_MAX_WIDTH } from '../theme';
import T from '../T';
import IconButton from './IconButton';

type Props = {
  visible: boolean;
  closeLabel?: string;
  touchSize?: number;
  restrainedMotion?: boolean;
  trapFocus?: boolean;
  onRequestClose?: () => void;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  testID?: string;
  closeTestID?: string;
  scrimTestID?: string;
};

/**
 * Bottom-anchored sheet surface (design_guidelines.json: "slide-up drawers instead of
 * center-screen dialogs"). Built on RN Modal + Animated so it works on web too. On wide
 * viewports it caps width and centers. The grab handle + scrim tap + hardware back all close.
 */
export default function Sheet({
  visible, onClose, title, children, testID, closeTestID, scrimTestID,
  closeLabel = "Close payment sheet", touchSize, restrainedMotion = false, trapFocus = false, onRequestClose,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const translateY = useRef(new Animated.Value(height)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); });
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; listener.remove(); };
  }, []);
  useEffect(() => {
    if (!visible || !trapFocus || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = () => document.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
    const controls = () => Array.from(surface()?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
      .filter((element) => element.getAttribute('aria-disabled') !== 'true');
    const timer = setTimeout(() => controls()[0]?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const options = controls();
        if (!options.length) { event.preventDefault(); return; }
        const index = options.indexOf(document.activeElement as HTMLElement);
        if (index < 0 || (!event.shiftKey && index === options.length - 1) || (event.shiftKey && index === 0)) {
          event.preventDefault(); options[event.shiftKey ? options.length - 1 : 0].focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, [visible, trapFocus, testID]);

  useEffect(() => {
    if (visible && restrainedMotion && reduceMotion) {
      fade.setValue(1); translateY.setValue(0);
    } else if (visible) {
      const animation = Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: restrainedMotion ? 180 : MOTION.base, useNativeDriver: Platform.OS !== 'web' }),
        restrainedMotion ? Animated.timing(translateY, { toValue: 0, duration: 180, useNativeDriver: Platform.OS !== 'web' }) : Animated.spring(translateY, { toValue: 0, useNativeDriver: Platform.OS !== 'web', damping: 22, stiffness: 240, mass: 0.7 }),
      ]);
      animation.start();
      return () => animation.stop();
    } else {
      translateY.setValue(height);
      fade.setValue(0);
    }
  }, [visible, height, translateY, fade, restrainedMotion, reduceMotion]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onRequestClose ?? onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Animated.View style={[styles.scrim, { backgroundColor: colors.scrim, opacity: fade }]}>
        <Pressable
          testID={scrimTestID}
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel={closeLabel}
          accessibilityRole="button"
        />
        <Animated.View
          testID={testID}
          accessibilityViewIsModal
          role={trapFocus ? 'dialog' : undefined}
          aria-modal={trapFocus || undefined}
          accessibilityLabel={trapFocus ? title : undefined}
          style={[
            styles.sheet,
            SHADOW.sheet,
            {
              backgroundColor: colors.surface,
              paddingBottom: insets.bottom + SPACING.lg,
              maxHeight: Math.min(height * 0.92, height - insets.top),
              transform: [{ translateY }],
              width: Math.min(width, CONTENT_MAX_WIDTH),
              alignSelf: 'center',
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          {title ? (
            <View style={styles.titleRow}>
              <T variant="h3" style={{ flex: 1, fontSize: trapFocus ? 20 : undefined }}>{title}</T>
              <IconButton
                name="close"
                onPress={onClose}
                accessibilityLabel={closeLabel}
                variant="surface"
                size={18}
                touchSize={touchSize}
                reducedMotion={restrainedMotion && reduceMotion}
                testID={closeTestID}
              />
            </View>
          ) : null}
          {children}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
  },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: SPACING.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.md },
});
