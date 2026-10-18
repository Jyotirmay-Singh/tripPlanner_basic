import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import { COMPONENT_SIZE, FONTS, SPACING, TYPESCALE } from './theme';
import { useTheme } from './ThemeContext';
import { Card, Icon } from './ui';
import T from './T';
import ConfirmModal from './ConfirmModal';

type Props = {
  value: boolean;
  onChange: (value: boolean) => void;
  testIDPrefix: string;
  disabled?: boolean;
  canChange?: boolean;
  hasSettlements?: boolean;
  offline?: boolean;
};

const CARRYOVER_NOTICE = 'Completed settlements remain cleared. Earlier unpaid settlement pairs may carry forward.';

export default function DebtSimplificationSetting({
  value, onChange, testIDPrefix, disabled = false, canChange = true,
  hasSettlements = false, offline = false,
}: Props) {
  const { colors } = useTheme();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const readOnly = disabled || !canChange;

  const requestChange = (enabled: boolean) => {
    if (readOnly) return;
    if (enabled) onChange(true);
    else setConfirmDisable(true);
  };

  return <>
    <Card testID={`${testIDPrefix}-debt-settings`} padding="none" style={styles.card}>
      <View style={styles.row}>
        <Pressable
          testID={`${testIDPrefix}-debt-info`}
          accessibilityRole="button"
          accessibilityLabel="About debt simplification"
          onPress={() => setShowInfo(true)}
          style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => [
            styles.copy,
            pressed && { opacity: 0.8 },
            focused && Platform.OS === 'web' && {
              outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2,
            },
          ]}
        >
          <View style={styles.heading}>
            <T style={styles.title}>Simplify group debts</T>
            <Icon name="info" size={16} color={colors.textMuted} />
          </View>
          <T variant="caption" muted style={styles.recommendation}>
            {value ? 'Recommended: Fewer payments and simpler settlement.'
              : 'Members repay expense payers directly, with mutual debts offset between each pair.'}
          </T>
        </Pressable>
        <View style={styles.switchTarget}>
          <Pressable style={StyleSheet.absoluteFill}
            accessible={false} accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants" focusable={false} tabIndex={-1}
            disabled={readOnly} onPress={() => requestChange(!value)} />
          <Switch
            testID={`${testIDPrefix}-simplify-debts`}
            accessibilityLabel="Simplify group debts"
            accessibilityHint={canChange
              ? 'Combine balances to reduce repayments. Turning off requires confirmation.'
              : 'Only the group owner or application administrator can change this setting.'}
            value={value}
            disabled={readOnly}
            onValueChange={requestChange}
            hitSlop={12}
            style={Platform.OS === 'web' ? styles.webSwitch : styles.nativeSwitch}
            {...(Platform.OS === 'web' ? { activeThumbColor: colors.primaryText } : {})}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor={value ? colors.primaryText : colors.textMuted}
            ios_backgroundColor={colors.border}
          />
        </View>
      </View>
      {hasSettlements ? <T variant="caption" muted testID={`${testIDPrefix}-debt-carryover`}>
        {CARRYOVER_NOTICE}
      </T> : null}
      {!canChange ? <T variant="caption" muted>Managed by the group owner.</T> : null}
      {offline ? <T variant="caption" muted>Connect to update group settings.</T> : null}
    </Card>
    {showInfo ? <ConfirmModal
      visible
      title="About debt simplification"
      message={<>
        We combine group balances to{' '}
        <T muted style={styles.emphasis}>reduce the number of repayments</T>.
        {' '}You may pay someone other than the original expense payer, while everyone’s share of the expenses stays the same.
      </>}
      onRequestClose={() => setShowInfo(false)}
      testID={`${testIDPrefix}-debt-info-dialog`}
      actions={[{ label: 'Got it', variant: 'primary', onPress: () => setShowInfo(false) }]}
    /> : null}
    <ConfirmModal
      visible={confirmDisable}
      title="Turn off debt simplification?"
      message={'Members will repay the original expense payers, with mutual debts offset. Turning off debt simplification may increase the number of payments required to settle the group.'
        + (hasSettlements ? `\n\n${CARRYOVER_NOTICE}` : '')}
      onRequestClose={() => setConfirmDisable(false)}
      testID={`${testIDPrefix}-debt-confirm`}
      actions={[
        { label: 'Keep enabled', variant: 'cancel', onPress: () => setConfirmDisable(false), testID: `${testIDPrefix}-debt-keep` },
        { label: 'Turn off', variant: 'primary', testID: `${testIDPrefix}-debt-disable`, onPress: () => {
          if (!readOnly) onChange(false);
          setConfirmDisable(false);
        } },
      ]}
    />
  </>;
}

const styles = StyleSheet.create({
  emphasis: { fontFamily: FONTS.bodyBold },
  card: { padding: SPACING.sm, gap: SPACING.xs },
  copy: { flex: 1, minWidth: 0, minHeight: COMPONENT_SIZE.minTouchTarget, justifyContent: 'center', gap: SPACING.xs },
  heading: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  title: { flexShrink: 1, fontFamily: FONTS.bodyMedium, fontSize: TYPESCALE.md, lineHeight: 22 },
  recommendation: { fontFamily: FONTS.body, fontSize: TYPESCALE.xs, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  webSwitch: { width: 40, height: 20 },
  nativeSwitch: { transform: [{ scale: 0.78 }] },
  switchTarget: { minHeight: COMPONENT_SIZE.minTouchTarget, width: COMPONENT_SIZE.minTouchTarget, flexShrink: 0, justifyContent: 'center', alignItems: 'center' },
});
