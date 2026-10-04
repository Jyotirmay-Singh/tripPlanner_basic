/* eslint-disable @typescript-eslint/no-require-imports */
import eas from '../../eas.json';

let mockPlatform = 'android';
jest.mock('react-native', () => ({ Platform: { get OS() { return mockPlatform; } } }));

const originalQa = process.env.EXPO_PUBLIC_OFFLINE_QA;
const originalWrites = process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES;

beforeEach(() => {
  mockPlatform = 'android';
  delete process.env.EXPO_PUBLIC_OFFLINE_QA;
  delete process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES;
});

afterEach(() => {
  if (originalQa === undefined) delete process.env.EXPO_PUBLIC_OFFLINE_QA;
  else process.env.EXPO_PUBLIC_OFFLINE_QA = originalQa;
  if (originalWrites === undefined) delete process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES;
  else process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES = originalWrites;
});

function activation(): typeof import('../offlineActivation') {
  let module!: typeof import('../offlineActivation');
  jest.isolateModules(() => { module = require('../offlineActivation'); });
  return module;
}

it('enables ordinary Android saves without the disposable QA flag or a release env override', () => {
  expect(activation().offlineWritesActive()).toBe(true);
});

it.each(['development', 'preview', 'production'] as const)(
  'enables expense and payment staging in the %s build configuration', (profile) => {
    const env = eas.build[profile].env;
    expect(env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES).toBe('true');
    expect(env).not.toHaveProperty('EXPO_PUBLIC_OFFLINE_QA');
    process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES = env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES;
    expect(activation().offlineWritesActive()).toBe(true);
  },
);

it('supports an explicit build opt-out and keeps the separate QA package enabled', () => {
  process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES = 'false';
  expect(activation().offlineWritesActive()).toBe(false);
  process.env.EXPO_PUBLIC_OFFLINE_QA = 'true';
  expect(activation().offlineWritesActive()).toBe(true);
});

it.each(['web', 'ios'])('keeps Android expense and payment staging out of %s', (platform) => {
  mockPlatform = platform;
  process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES = 'true';
  expect(activation().offlineWritesActive()).toBe(false);
});
