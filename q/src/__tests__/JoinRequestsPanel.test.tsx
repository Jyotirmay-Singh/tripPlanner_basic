/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockList = jest.fn();
const mockApprove = jest.fn();
const mockReject = jest.fn();

jest.mock('../api', () => ({
  listJoinRequests: mockList,
  approveJoinRequest: mockApprove,
  rejectJoinRequest: mockReject,
}));

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1c3f39', surface: '#ffffff', surfaceMuted: '#eeeeee',
      border: '#dddddd', textMuted: '#666666', danger: '#cc3300',
    },
  }),
}));

jest.mock('../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(Text, props, props.children) };
});

jest.mock('../ui', () => {
  const R = require('react');
  const { Text, TextInput, TouchableOpacity, View } = require('react-native');
  return {
    Button: ({ label, onPress, testID, disabled, loading }: any) => R.createElement(
      TouchableOpacity,
      { testID, onPress, disabled: disabled || loading },
      R.createElement(Text, null, label),
    ),
    Card: ({ children, testID }: any) => R.createElement(View, { testID }, children),
    Icon: ({ name }: any) => R.createElement(Text, null, name),
    Input: (props: any) => R.createElement(TextInput, props),
  };
});

jest.mock('../ConfirmModal', () => {
  const R = require('react');
  const { TouchableOpacity, View } = require('react-native');
  return {
    __esModule: true,
    default: ({ visible, testID, actions }: any) => visible
      ? R.createElement(
        View,
        { testID },
        actions.map((action: any) => R.createElement(
          TouchableOpacity,
          { key: action.label, testID: action.testID, onPress: action.onPress },
        )),
      )
      : null,
  };
});

const JoinRequestsPanel = require('../JoinRequestsPanel').default;

const request = {
  id: 'request-1',
  trip: { id: 'trip-1', name: 'Coast trip', code: 'ABC123' },
  target: {
    kind: 'family_member', member_id: 'family-1', family_member_id: 'slot-1',
    family_id: 'family-1', family_name: 'Sharma family', name: 'Priya',
  },
  requester: { user_id: 'user-2', name: 'Priya S', email: 'priya@gmail.com' },
  target_email: 'old@gmail.com',
  email_relation: 'different',
  status: 'pending',
  created_at: '2026-09-04T10:00:00Z',
};

async function renderPanel(onRosterChanged = jest.fn()) {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <JoinRequestsPanel tripId="trip-1" onRosterChanged={onRosterChanged} />,
    );
    await Promise.resolve();
  });
  return { renderer: renderer!, onRosterChanged };
}

describe('JoinRequestsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue([request]);
    mockApprove.mockResolvedValue({ ...request, status: 'approved' });
    mockReject.mockResolvedValue({ ...request, status: 'rejected' });
  });

  it('confirms approval and refreshes the roster', async () => {
    const { renderer, onRosterChanged } = await renderPanel();

    act(() => {
      renderer.root.findByProps({ testID: 'join-request-approve-request-1' }).props.onPress();
    });
    expect(renderer.root.findByProps({ testID: 'join-request-approve-modal' })).toBeTruthy();
    await act(async () => {
      renderer.root.findByProps({ testID: 'join-request-approve-confirm' }).props.onPress();
      await Promise.resolve();
    });

    expect(mockApprove).toHaveBeenCalledWith('trip-1', 'request-1');
    expect(onRosterChanged).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('sends an optional rejection reason', async () => {
    const { renderer } = await renderPanel();

    act(() => {
      renderer.root.findByProps({ testID: 'join-request-reject-request-1' }).props.onPress();
    });
    act(() => {
      renderer.root.findByProps({ testID: 'join-request-reason-request-1' })
        .props.onChangeText('Please use the other Priya');
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'join-request-reject-confirm-request-1' }).props.onPress();
      await Promise.resolve();
    });

    expect(mockReject).toHaveBeenCalledWith(
      'trip-1', 'request-1', 'Please use the other Priya',
    );
  });
});
