import React, { useRef } from 'react';
import {
  Animated, Pressable, StyleSheet, Platform,
  type StyleProp, type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { initials } from './initials';
import { COMPONENT_SIZE, RADIUS, PRESS_SCALE, TYPESCALE, FONTS } from './theme';
import T from './T';
import { Icon } from './ui';

// Universal top-right header button (replaces the old LogoutButton). A circular avatar shows the
// user's initials, or a person icon when no display name is available; tapping it opens Profile, where
// the "Sign out" row still hosts the Step-21 logout flow. Mirrors ui/IconButton's cross-platform
// care (Animated press-scale, native-only haptics, web focus outline) so it matches the app.

type Props = {
  /** Override the wrapper spacing when the avatar is rendered outside a navigator header. */
  containerStyle?: StyleProp<ViewStyle>;
};

export default function ProfileAvatarButton({ containerStyle }: Props) {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const scale = useRef(new Animated.Value(1)).current;

  const ini = initials(user?.name);
  const profileLabel = user?.name?.trim()
    ? `Open profile for ${user.name.trim()}`
    : 'Open profile';

  const animate = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: Platform.OS !== 'web', speed: 50, bounciness: 0 }).start();

  return (
    <Animated.View style={[styles.container, { transform: [{ scale }] }, containerStyle]}>
      <Pressable
        testID="header-profile-avatar"
        onPress={() => {
          if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
          router.navigate('/(tabs)/profile');
        }}
        onPressIn={() => animate(PRESS_SCALE)}
        onPressOut={() => animate(1)}
        accessibilityRole="button"
        accessibilityLabel={profileLabel}
        style={({ focused }: any) => [
          styles.circle,
          { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
        ]}
      >
        {ini !== ''
          ? <T style={styles.initials} color={colors.primary}>{ini}</T>
          : <Icon name="user-round" size={20} color={colors.primary} />}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Native navigation headers need a small trailing gutter. Inline consumers override it to 0.
  container: { marginRight: 6 },
  circle: {
    width: COMPONENT_SIZE.headerControl,
    height: COMPONENT_SIZE.headerControl,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  // Initials are the avatar identity; the person glyph is reserved for a missing display name.
  initials: {
    fontFamily: FONTS.bodyBold,
    fontSize: TYPESCALE.base,
    lineHeight: 20,
    letterSpacing: 0.75,
  },
});
