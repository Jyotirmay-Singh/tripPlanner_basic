/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const originalBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

afterEach(() => {
  if (originalBackendUrl == null) delete process.env.EXPO_PUBLIC_BACKEND_URL;
  else process.env.EXPO_PUBLIC_BACKEND_URL = originalBackendUrl;
  jest.restoreAllMocks();
  jest.resetModules();
});

it('preserves a missing endpoint as a non-transport configuration error', async () => {
  delete process.env.EXPO_PUBLIC_BACKEND_URL;
  jest.resetModules();
  const { api, ApiError } = require('../api');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  await expect(api('/meta/config', { auth: false })).rejects.toMatchObject({
    name: 'ApiError',
    code: 'configuration',
  });
  await expect(api('/meta/config', { auth: false })).rejects.toBeInstanceOf(ApiError);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('preserves HTTP status and classifies an actual fetch rejection as network failure', async () => {
  process.env.EXPO_PUBLIC_BACKEND_URL = 'https://api.example.test/';
  jest.resetModules();
  const { api } = require('../api');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce({
    ok: false,
    status: 403,
    text: () => Promise.resolve(JSON.stringify({ detail: 'Not a member' })),
  } as Response);

  await expect(api('/trips/t1/chat/messages')).rejects.toMatchObject({
    code: 'http',
    status: 403,
    message: 'Not a member',
  });

  fetchSpy.mockRejectedValueOnce(new TypeError('connection failed'));
  await expect(api('/trips/t1/chat/messages')).rejects.toMatchObject({
    code: 'network',
    message: 'Could not reach the server',
  });
});
