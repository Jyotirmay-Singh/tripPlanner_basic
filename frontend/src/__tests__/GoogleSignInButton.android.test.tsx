/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const previousWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'test-web-client.apps.googleusercontent.com';

const mockConfigure = jest.fn();
const mockCheckPlayServices = jest.fn();
const mockPresentExplicitSignIn = jest.fn();
const mockSignInWithGoogle = jest.fn();
const mockReplace = jest.fn();
const mockToastShow = jest.fn();

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { executionEnvironment: 'standalone' },
  ExecutionEnvironment: {
    Bare: 'bare',
    Standalone: 'standalone',
    StoreClient: 'storeClient',
  },
}));

jest.mock('react-native-nitro-google-signin', () => ({
  __esModule: true,
  GoogleOneTapSignIn: {
    configure: mockConfigure,
    checkPlayServices: mockCheckPlayServices,
    presentExplicitSignIn: mockPresentExplicitSignIn,
  },
  isCancelledResponse: (response: { type: string }) => response.type === 'cancelled',
  isSuccessResponse: (response: { type: string; data: unknown }) => (
    response.type === 'success' && response.data != null
  ),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('../AuthContext', () => ({
  useAuth: () => ({ signInWithGoogle: mockSignInWithGoogle }),
}));

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: { surface: '#fff', border: '#ddd', textMain: '#111' },
  }),
}));

jest.mock('../ui', () => ({
  useToast: () => ({ show: mockToastShow }),
}));

jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});

jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  return { Ionicons: (props: any) => R.createElement('Ionicons', props) };
});

const googleButtonModule = require('../GoogleSignInButton.android');
const GoogleSignInButton = googleButtonModule.default;
const { isAndroidGoogleAuthAvailable } = googleButtonModule;

function successResponse(idToken = 'google-id-token') {
  return {
    type: 'success',
    data: {
      idToken,
      serverAuthCode: null,
      scopes: [],
      user: { id: 'google-user' },
    },
  };
}

function renderButton() {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(<GoogleSignInButton />);
  });
  return renderer!.root.findByProps({ testID: 'google-signin' });
}

describe('Android Credential Manager Google sign-in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckPlayServices.mockResolvedValue(undefined);
    mockPresentExplicitSignIn.mockResolvedValue(successResponse());
    mockSignInWithGoogle.mockResolvedValue({ credentials_set: true });
  });

  afterAll(() => {
    if (previousWebClientId === undefined) {
      delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    } else {
      process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = previousWebClientId;
    }
  });

  it('uses the Web audience, sends only the ID token to the backend, and creates the app session', async () => {
    const button = renderButton();

    await act(async () => {
      await button.props.onPress();
    });

    expect(mockConfigure).toHaveBeenCalledWith({
      webClientId: 'test-web-client.apps.googleusercontent.com',
      offlineAccess: false,
    });
    expect(mockCheckPlayServices).toHaveBeenCalledTimes(1);
    expect(mockPresentExplicitSignIn).toHaveBeenCalledTimes(1);
    expect(mockSignInWithGoogle).toHaveBeenCalledWith('google-id-token');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(mockToastShow).not.toHaveBeenCalled();
  });

  it('keeps the first-time Google-user credentials setup route', async () => {
    mockSignInWithGoogle.mockResolvedValueOnce({ credentials_set: false });
    const button = renderButton();

    await act(async () => {
      await button.props.onPress();
    });

    expect(mockReplace).toHaveBeenCalledWith('/set-credentials');
  });

  it('treats account-picker cancellation as a no-op', async () => {
    mockPresentExplicitSignIn.mockResolvedValueOnce({ type: 'cancelled', data: null });
    const button = renderButton();

    await act(async () => {
      await button.props.onPress();
    });

    expect(mockSignInWithGoogle).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockToastShow).not.toHaveBeenCalled();
  });

  it('hides native Google auth when the Web client ID is missing or the app is Expo Go', () => {
    expect(isAndroidGoogleAuthAvailable(undefined, 'standalone')).toBe(false);
    expect(isAndroidGoogleAuthAvailable('web.apps.googleusercontent.com', 'storeClient')).toBe(false);
    expect(isAndroidGoogleAuthAvailable('web.apps.googleusercontent.com', 'standalone')).toBe(true);
  });

  it.each([
    ['PLAY_SERVICES_NOT_AVAILABLE', 'Update Google Play Services to continue.'],
    ['DEVELOPER_ERROR', 'Google sign-in is not configured for this app build.'],
  ])('maps %s to a safe actionable error', async (code, message) => {
    mockCheckPlayServices.mockRejectedValueOnce(Object.assign(new Error('native details'), { code }));
    const button = renderButton();

    await act(async () => {
      await button.props.onPress();
    });

    expect(mockToastShow).toHaveBeenCalledWith(message, 'error');
    expect(mockSignInWithGoogle).not.toHaveBeenCalled();
  });

  it('prevents two rapid presses from opening duplicate native requests', async () => {
    const button = renderButton();

    await act(async () => {
      await Promise.all([button.props.onPress(), button.props.onPress()]);
    });

    expect(mockCheckPlayServices).toHaveBeenCalledTimes(1);
    expect(mockPresentExplicitSignIn).toHaveBeenCalledTimes(1);
    expect(mockSignInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('does not log native errors, token-like values, or credential objects', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const button = renderButton();
    log.mockClear();
    warn.mockClear();
    error.mockClear();
    mockCheckPlayServices.mockRejectedValueOnce(Object.assign(
      new Error('token=secret-looking-value'),
      { code: 'DEVELOPER_ERROR' },
    ));

    await act(async () => {
      await button.props.onPress();
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(mockToastShow).toHaveBeenCalledWith(
      'Google sign-in is not configured for this app build.',
      'error',
    );

    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});
