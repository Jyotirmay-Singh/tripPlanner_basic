import React, { forwardRef } from 'react';
import { ScrollView, View } from 'react-native';
import type {
  KeyboardAwareScrollViewProps,
  KeyboardAwareScrollViewRef,
  KeyboardAvoidingViewProps,
  KeyboardStickyViewProps,
} from 'react-native-keyboard-controller';

/** The native module is deliberately absent from the static web bundle. */
export function AppKeyboardProvider({ children }: React.PropsWithChildren) {
  return <>{children}</>;
}

export const KeyboardAwareScrollView = forwardRef<
  KeyboardAwareScrollViewRef,
  React.PropsWithChildren<KeyboardAwareScrollViewProps>
>(function WebKeyboardAwareScrollView(
  {
    bottomOffset: _bottomOffset,
    disableScrollOnKeyboardHide: _disableScrollOnKeyboardHide,
    enabled: _enabled,
    extraKeyboardSpace: _extraKeyboardSpace,
    mode: _mode,
    ScrollViewComponent: _ScrollViewComponent,
    ...props
  },
  ref,
) {
  return <ScrollView ref={ref as React.Ref<ScrollView>} {...props} />;
});

export const KeyboardAvoidingView = forwardRef<
  View,
  React.PropsWithChildren<KeyboardAvoidingViewProps>
>(function WebKeyboardAvoidingView(
  {
    automaticOffset: _automaticOffset,
    behavior: _behavior,
    contentContainerStyle: _contentContainerStyle,
    enabled: _enabled,
    keyboardVerticalOffset: _keyboardVerticalOffset,
    ...props
  },
  ref,
) {
  return <View ref={ref} {...props} />;
});

export const KeyboardStickyView = forwardRef<
  View,
  React.PropsWithChildren<KeyboardStickyViewProps>
>(function WebKeyboardStickyView(
  {
    enabled: _enabled,
    offset: _offset,
    ...props
  },
  ref,
) {
  return <View ref={ref} {...props} />;
});

/** Browsers manage their own visual viewport; native keyboard geometry is not applicable. */
export function useAppKeyboardState() {
  return { height: 0, isVisible: false };
}

/** Match native Next behavior without importing the native controller into the web build. */
export function focusNextInput() {
  if (typeof document === 'undefined') return;
  const fields = Array.from(document.querySelectorAll<HTMLElement>(
    'input:not([disabled]), textarea:not([disabled]), [contenteditable="true"]',
  ));
  const current = fields.indexOf(document.activeElement as HTMLElement);
  fields[current + 1]?.focus();
}
