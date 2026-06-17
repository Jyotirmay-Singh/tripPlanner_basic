import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './ThemeContext';
import { useLogout } from './useLogout';

export default function LogoutButton() {
  const { colors } = useTheme();
  const { confirmAndSignOut } = useLogout();
  return (
    <TouchableOpacity testID="header-logout" onPress={confirmAndSignOut}
      style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
      <Ionicons name="log-out-outline" size={26} color={colors.textMain} />
    </TouchableOpacity>
  );
}
