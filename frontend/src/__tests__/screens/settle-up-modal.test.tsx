/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
//
// Focused test for the settle-up record/edit modal (AmountModal in app/trip/[id]/settle-up.tsx):
//  - the explicit ✕ (payment-close) CANCELS without recording (calls onCancel, never onSubmit);
//  - the restructured modal still mounts the amount + remark inputs and the footer buttons, and
//    Continue submits (footer stays wired/reachable). Heavy screen deps are stubbed so importing
//    the route module doesn't pull the network / router; the modal uses the REAL
//    validatePaymentAmount + formatMoney.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('expo-router', () => ({ useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: 't1' }) }));
jest.mock('../../api', () => ({
  api: jest.fn(), listPayments: jest.fn(), recordPayment: jest.fn(), editPayment: jest.fn(), deletePayment: jest.fn(),
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }) }));
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (p: any) => R.createElement(name, p, p && p.children);
  return {
    __esModule: true,
    Screen: stub('Screen'), Card: stub('Card'), Button: stub('Button'), Icon: stub('Icon'),
    IconButton: stub('IconButton'), Input: stub('Input'), EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'), SkeletonCard: stub('SkeletonCard'), ProgressBar: stub('ProgressBar'),
    useToast: () => ({ show: jest.fn() }),
  };
});

import { AmountModal } from '../../../app/trip/[id]/settle-up';

const host = (r: any, id: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props && n.props.testID === id);
const hasHost = (r: any, id: string) =>
  r.root.findAll((n: any) => typeof n.type === 'string' && n.props && n.props.testID === id).length > 0;
const buttonByLabel = (r: any, label: string) =>
  r.root.find((n: any) => n.type === 'Button' && n.props && n.props.label === label);

function mount(onCancel: jest.Mock, onSubmit: jest.Mock) {
  let r: any;
  act(() => {
    r = TestRenderer.create(React.createElement(AmountModal, {
      title: 'Record payment', subtitle: 'Ram pays Shyam', initial: 100, max: 100, currency: 'INR',
      initialNote: '', submitLabel: 'Continue', onCancel, onSubmit,
    }));
  });
  return r;
}

describe('settle-up AmountModal (✕ close + reachable footer)', () => {
  it('renders the amount + remark inputs and the footer buttons', () => {
    const r = mount(jest.fn(), jest.fn());
    expect(hasHost(r, 'payment-amount-input')).toBe(true);
    expect(hasHost(r, 'payment-remark-input')).toBe(true);
    expect(hasHost(r, 'payment-amount-continue')).toBe(true);
    expect(hasHost(r, 'payment-close')).toBe(true);
    expect(buttonByLabel(r, 'Cancel')).toBeTruthy();
  });

  it('✕ cancels WITHOUT recording (onCancel, never onSubmit)', () => {
    const onCancel = jest.fn(); const onSubmit = jest.fn();
    const r = mount(onCancel, onSubmit);
    act(() => { host(r, 'payment-close').props.onPress(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Cancel button also cancels without recording', () => {
    const onCancel = jest.fn(); const onSubmit = jest.fn();
    const r = mount(onCancel, onSubmit);
    act(() => { buttonByLabel(r, 'Cancel').props.onPress(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Continue submits the initial valid amount (footer stays wired)', () => {
    const onCancel = jest.fn(); const onSubmit = jest.fn();
    const r = mount(onCancel, onSubmit);
    act(() => { host(r, 'payment-amount-continue').props.onPress(); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe(100); // amount
    expect(onCancel).not.toHaveBeenCalled();
  });
});
