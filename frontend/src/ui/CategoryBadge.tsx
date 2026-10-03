import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../ThemeContext';
import { categoryAccent, categoryBadgeColor, categoryIcon } from '../categories';
import Icon from './Icon';
export default function CategoryBadge({ name, size = 22 }: { name: string; size?: number }) {
  const { mode, colors } = useTheme();
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      backgroundColor: categoryBadgeColor(name, mode, colors.surface) }}>
    <Icon name={categoryIcon(name)} size={size} color={categoryAccent(name, mode)} />
  </View>;
}
