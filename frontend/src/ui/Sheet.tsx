import React, { useEffect, useRef } from 'react';
import {
  Modal, Animated, Pressable, View, StyleSheet, Platform, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS, SHADOW, MOTION, CONTENT_MAX_WIDTH } from '../theme';
import T from '../T';
import IconButton from './IconButton';

type Props = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  testID?: string;
};

/**
 * Bottom-anchored sheet surface (design_guidelines.json: "slide-up drawers instead of
 * center-screen dialogs"). Built on RN Modal + Animated so it works on web too. On wide
 * viewports it caps width and centers. The grab handle + scrim tap + hardware back all close.
 */
export default function Sheet({ visible, onClose, title, children, testID }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const translateY = useRef(new Animated.Value(height)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: MOTION.base, useNativeDriver: Platform.OS !== 'web' }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: Platform.OS !== 'web', damping: 22, stiffness: 240, mass: 0.7 }),
      ]).start();
    } else {
      translateY.setValue(height);
      fade.setValue(0);
    }
  }, [visible, height, translateY, fade]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.scrim, { backgroundColor: colors.scrim, opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <Animated.View
          testID={testID}
          style={[
            styles.sheet,
            SHADOW.sheet,
            {
              backgroundColor: colors.surface,
              paddingBottom: insets.bottom + SPACING.lg,
              maxHeight: height * 0.92,
              transform: [{ translateY }],
              width: Math.min(width, CONTENT_MAX_WIDTH),
              alignSelf: 'center',
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          {title ? (
            <View style={styles.titleRow}>
              <T variant="h3" style={{ flex: 1 }}>{title}</T>
              <IconButton name="close" onPress={onClose} accessibilityLabel="Close" variant="surface" size={18} />
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
