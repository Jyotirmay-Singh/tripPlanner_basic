import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { CONTENT_MAX_WIDTH, SPACING } from '../theme';

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
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.column, contentStyle]}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { padding: SPACING.lg, alignItems: 'center' },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md },
});
