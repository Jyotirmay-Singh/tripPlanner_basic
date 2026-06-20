import React from 'react';
import { useTheme } from './ThemeContext';
import { useLogout } from './useLogout';
import IconButton from './ui/IconButton';

export default function LogoutButton() {
  const { colors } = useTheme();
  const { confirmAndSignOut } = useLogout();
  return (
    <IconButton
      testID="header-logout"
      name="logout"
      onPress={confirmAndSignOut}
      accessibilityLabel="Sign out"
      color={colors.textMain}
      size={22}
      style={{ marginRight: 6 }}
    />
  );
}
