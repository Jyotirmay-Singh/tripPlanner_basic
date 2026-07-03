import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { initials } from './initials';
import { RADIUS, PRESS_SCALE, TYPESCALE, FONTS } from './theme';
import T from './T';
import { Icon } from './ui';

// Universal top-right header button (replaces the old LogoutButton). A filled circular avatar
// showing a person icon with the user's initials below it; tapping it opens the Profile tab, where
// the "Sign out" row still hosts the Step-21 logout flow. Mirrors ui/IconButton's cross-platform
// care (Animated press-scale, native-only haptics, web focus outline) so it matches the app.
const SIZE = 40;

export default function ProfileAvatarButton() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const scale = useRef(new Animated.Value(1)).current;

  const ini = initials(user?.name);

  const animate = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: Platform.OS !== 'web', speed: 50, bounciness: 0 }).start();

  return (
    <Animated.View style={{ transform: [{ scale }], marginRight: 6 }}>
      <Pressable
        testID="header-profile-avatar"
        onPress={() => {
          if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
          router.navigate('/(tabs)/profile');
        }}
        onPressIn={() => animate(PRESS_SCALE)}
        onPressOut={() => animate(1)}
        accessibilityRole="button"
        accessibilityLabel="Open profile"
        hitSlop={8}
        style={({ focused }: any) => [
          styles.circle,
          { backgroundColor: colors.primary },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
        ]}
      >
        <Icon name="user-round" size={14} color={colors.primaryText} />
        {ini !== '' && (
          <T style={styles.initials} color={colors.primaryText}>{ini}</T>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: SIZE, height: SIZE, borderRadius: RADIUS.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  // Compact uppercase initials tucked under the person icon; sized to the smallest type token.
  initials: {
    fontFamily: FONTS.bodyBold, fontSize: TYPESCALE.xs, lineHeight: 13,
    letterSpacing: 0.5, marginTop: 1,
  },
});
