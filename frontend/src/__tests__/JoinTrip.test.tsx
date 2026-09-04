/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { ExistingPerson, JoinMatch } from '../../src/joinIdentity';

const mockReplace = jest.fn();
const mockRouter = { replace: mockReplace };
const mockPreviewJoin = jest.fn();
const mockJoinTrip = jest.fn();
const mockRequestExistingPerson = jest.fn();
const mockGetJoinRequest = jest.fn();
const mockCancelJoinRequest = jest.fn();
let mockParams: { requestId?: string; inviteToken?: string } = {};
const mockClearPendingInvite = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../../src/api', () => ({
  __esModule: true,
  previewJoin: mockPreviewJoin,
  joinTrip: mockJoinTrip,
  requestExistingPerson: mockRequestExistingPerson,
  getJoinRequest: mockGetJoinRequest,
  cancelJoinRequest: mockCancelJoinRequest,
}));

jest.mock('../../src/AuthContext', () => ({
  useAuth: () => ({ clearPendingInvite: mockClearPendingInvite }),
}));

jest.mock('../../src/ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      background: '#f7f5f0', surface: '#ffffff', surfaceMuted: '#edebe3',
      primary: '#1c3f39', primaryText: '#ffffff', textMain: '#121a18',
      textMuted: '#5c6b67', border: '#dcd9ce', danger: '#e05d3d',
      success: '#6b8e6b', warning: '#d4a373',
    },
  }),
}));

jest.mock('../../src/T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(Text, props, props.children) };
});

jest.mock('../../src/Badge', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ label }: any) => R.createElement(Text, null, label) };
});

jest.mock('../../src/ConfirmModal', () => {
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

jest.mock('../../src/ui', () => {
  const R = require('react');
  const { Text, TextInput, TouchableOpacity, View } = require('react-native');
  return {
    Button: ({ label, onPress, testID, disabled, loading }: any) => R.createElement(
      TouchableOpacity,
      { testID, onPress, disabled: disabled || loading },
      R.createElement(Text, null, label),
    ),
    FormScreen: ({ children, testID }: any) => R.createElement(View, { testID }, children),
    Icon: ({ name }: any) => R.createElement(Text, null, name),
    Input: (props: any) => R.createElement(TextInput, props),
  };
});

const JoinTrip = require('../../app/join-trip').default;

const trip = {
  id: 'trip-1', name: 'Mountain weekend', code: 'ABC123', member_count: 3,
};

type PreviewFixture = {
  trip: typeof trip;
  already_member: boolean;
  match: JoinMatch | null;
  active_request: null;
  existing_people: ExistingPerson[];
};

const rosterPreview: PreviewFixture = {
  trip,
  already_member: false,
  match: null,
  active_request: null,
  existing_people: [
    {
      kind: 'individual', member_id: 'person-1', name: 'Asha',
      resolution: 'approval_required',
    },
    {
      kind: 'family_member', member_id: 'family-1', family_member_id: 'slot-1',
      family_id: 'family-1', family_name: 'Sharma family', name: 'Priya',
      resolution: 'approval_required',
    },
  ],
};

const pendingRequest = {
  id: 'request-1',
  trip: { id: trip.id, name: trip.name, code: trip.code },
  target: {
    kind: 'family_member', member_id: 'family-1', family_member_id: 'slot-1',
    family_id: 'family-1', family_name: 'Sharma family', name: 'Priya',
  },
  status: 'pending',
  created_at: '2026-09-04T10:00:00Z',
};

async function renderAndEnterCode(preview: PreviewFixture = rosterPreview) {
  mockPreviewJoin.mockResolvedValueOnce(preview);
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<JoinTrip />);
  });
  act(() => {
    renderer!.root.findByProps({ testID: 'jt-code' }).props.onChangeText('abc123');
  });
  await act(async () => {
    renderer!.root.findByProps({ testID: 'jt-submit' }).props.onPress();
    await Promise.resolve();
  });
  return renderer!;
}

describe('join existing trip identity flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockJoinTrip.mockResolvedValue({ id: trip.id });
    mockRequestExistingPerson.mockResolvedValue(pendingRequest);
    mockCancelJoinRequest.mockResolvedValue({ ...pendingRequest, status: 'cancelled' });
  });

  it('shows individuals and family members first, then requests the selected family person', async () => {
    const renderer = await renderAndEnterCode();

    expect(mockPreviewJoin).toHaveBeenCalledWith({ code: 'ABC123' });
    expect(renderer.root.findByProps({ testID: 'jt-existing-individuals' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'jt-existing-family-members' })).toBeTruthy();

    act(() => {
      renderer.root.findByProps({ testID: 'jt-person-family-1:slot-1' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'jt-request-existing' }).props.onPress();
      await Promise.resolve();
    });

    expect(mockRequestExistingPerson).toHaveBeenCalledWith({
      code: 'ABC123', member_id: 'family-1', family_member_id: 'slot-1',
    });
    expect(renderer.root.findByProps({ testID: 'jt-request-status' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('opens a secure invite directly in the identity wizard without code entry', async () => {
    const inviteToken = 'a'.repeat(43);
    mockParams = { inviteToken };
    mockPreviewJoin.mockResolvedValueOnce(rosterPreview);
    let renderer: any;

    await act(async () => {
      renderer = TestRenderer.create(<JoinTrip />);
      await Promise.resolve();
    });

    expect(mockPreviewJoin).toHaveBeenCalledWith({ invite_token: inviteToken });
    expect(renderer!.root.findByProps({ testID: 'join-trip-roster-screen' })).toBeTruthy();
    expect(renderer!.root.findAllByProps({ testID: 'join-trip-code-screen' })).toHaveLength(0);
  });

  it('requests a standalone existing individual without a family member id', async () => {
    mockRequestExistingPerson.mockResolvedValueOnce({
      ...pendingRequest,
      target: { kind: 'individual', member_id: 'person-1', name: 'Asha' },
    });
    const renderer = await renderAndEnterCode();

    act(() => renderer.root.findByProps({ testID: 'jt-person-person-1:' }).props.onPress());
    await act(async () => {
      renderer.root.findByProps({ testID: 'jt-request-existing' }).props.onPress();
      await Promise.resolve();
    });

    expect(mockRequestExistingPerson).toHaveBeenCalledWith({
      code: 'ABC123', member_id: 'person-1',
    });
    act(() => renderer.unmount());
  });

  it('lets a clean incorrect family Gmail match detach before creating a new individual', async () => {
    const exactPreview: PreviewFixture = {
      ...rosterPreview,
      match: {
        member_id: 'family-1', member_type: 'family_member', member_name: 'Priya',
        family_id: 'family-1', family_name: 'Sharma family', family_member_id: 'slot-1',
        has_financial_history: false, can_replace: true,
      },
    };
    const renderer = await renderAndEnterCode(exactPreview);

    expect(renderer.root.findByProps({ testID: 'join-trip-exact-screen' })).toBeTruthy();
    act(() => renderer.root.findByProps({ testID: 'jt-identity-new' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'jt-join-confirm' }).props.onPress());
    expect(renderer.root.findByProps({ testID: 'jt-replace-modal' })).toBeTruthy();

    await act(async () => {
      renderer.root.findByProps({ testID: 'jt-replace-confirm' }).props.onPress();
      await Promise.resolve();
    });

    expect(mockJoinTrip).toHaveBeenCalledWith({
      code: 'ABC123', action: 'join_new', mode: 'individual',
      replace_family_member_id: 'slot-1',
    });
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-1');
  });

  it('opens a rejected request from a notification and returns to the current roster', async () => {
    mockParams = { requestId: 'request-1' };
    mockGetJoinRequest.mockResolvedValueOnce({
      ...pendingRequest,
      status: 'rejected',
      rejection_reason: 'Please choose the other Priya.',
      retry_after: '2026-09-05T10:00:00Z',
    });
    mockPreviewJoin.mockResolvedValueOnce(rosterPreview);
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<JoinTrip />);
      await Promise.resolve();
    });

    expect(mockGetJoinRequest).toHaveBeenCalledWith('request-1');
    expect(renderer!.root.findByProps({ testID: 'jt-request-status' })).toBeTruthy();
    await act(async () => {
      renderer!.root.findByProps({ testID: 'jt-request-choose-again' }).props.onPress();
      await Promise.resolve();
    });

    expect(mockPreviewJoin).toHaveBeenCalledWith({ code: 'ABC123' });
    expect(renderer!.root.findByProps({ testID: 'join-trip-roster-screen' })).toBeTruthy();
  });
});
