import React from 'react';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import Screen, { type ScreenProps } from './Screen';

type Props = Omit<ScreenProps, 'bottomContentInset' | 'edges'>;

export default function TabScreen(props: Props) {
  const tabBarHeight = useBottomTabBarHeight();
  return (
    <Screen
      {...props}
      edges={['top', 'left', 'right']}
      bottomContentInset={tabBarHeight}
    />
  );
}
