import React from 'react';
import { TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';

export default function LogoutButton() {
  const { signOut } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const onPress = () => {
    Alert.alert('Sign out?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out', style: 'destructive',
        onPress: async () => { await signOut(); router.replace('/(auth)/login'); },
      },
    ]);
  };
  return (
    <TouchableOpacity testID="header-logout" onPress={onPress}
      style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
      <Ionicons name="log-out-outline" size={26} color={colors.textMain} />
    </TouchableOpacity>
  );
}
