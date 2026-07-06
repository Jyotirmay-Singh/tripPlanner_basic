import React from 'react';
import { Tabs } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '../../src/ThemeContext';
import { FONTS } from '../../src/theme';
import { Icon } from '../../src/ui';
import { IconName } from '../../src/ui/Icon';
import ProfileAvatarButton from '../../src/ProfileAvatarButton';

// Named so it carries a display name (lint) — the tab icon renderer.
function TabIcon({ name, color, focused, base = 24 }: { name: IconName; color: string; focused: boolean; base?: number }) {
  return <Icon name={name} color={color} size={focused ? base + 1 : base} strokeWidth={focused ? 2 : 1.75} />;
}

export default function TabsLayout() {
  const { colors, mode } = useTheme();

  // Crystal-glass tab bar (design_guidelines.json): a translucent surface fallback with a
  // BlurView over it, so it reads as frosted glass where blur is supported and still legible
  // where it isn't (e.g. some Android builds).
  const glassFallback = mode === 'dark' ? 'rgba(18,23,21,0.72)' : 'rgba(255,255,255,0.78)';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarBackground: () => (
          <BlurView
            tint={mode === 'dark' ? 'dark' : 'light'}
            intensity={Platform.OS === 'android' ? 0 : 50}
            style={StyleSheet.absoluteFill}
          />
        ),
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: glassFallback,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 24 : 10,
          height: Platform.OS === 'ios' ? 90 : 68,
          elevation: 0,
        },
        // With only four tabs, let each item flex evenly across the bar width.
        tabBarItemStyle: { flex: 1 },
        tabBarLabelStyle: { fontFamily: FONTS.bodySemibold, fontSize: 12 },
        headerShown: true,
        headerTitle: '',
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerRight: () => <ProfileAvatarButton />,
      }}
    >
      <Tabs.Screen name="dashboard" options={{ title: 'Home', tabBarIcon: (p) => <TabIcon name="home" {...p} /> }} />
      <Tabs.Screen name="trips" options={{ title: 'Trips', tabBarIcon: (p) => <TabIcon name="briefcase" {...p} /> }} />
      <Tabs.Screen name="reports" options={{ title: 'Reports', tabBarIcon: (p) => <TabIcon name="spreadsheet" {...p} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: (p) => <TabIcon name="user" {...p} /> }} />
    </Tabs>
  );
}
