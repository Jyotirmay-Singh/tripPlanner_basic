import React from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { CONTENT_MAX_WIDTH, SPACING } from '../theme';
import { KeyboardAwareScrollView } from '../KeyboardController';

type Props = {
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export default function FormScreen({ children, contentStyle, testID }: Props) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      style={[styles.fill, { backgroundColor: colors.background }]}
      edges={['left', 'right', 'bottom']}
      testID={testID}
    >
      <KeyboardAwareScrollView
        style={styles.fill}
        contentContainerStyle={styles.scroll}
        mode="insets"
        bottomOffset={48}
        disableScrollOnKeyboardHide
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      >
        <View style={[styles.column, contentStyle]}>{children}</View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { padding: SPACING.lg, alignItems: 'center' },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md },
});
