import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import ReceiptViewer from '../ReceiptViewer';

jest.setTimeout(15000);

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View }));
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: {
  surface: '#ffffff', primary: '#123456', primaryText: '#ffffff', textMain: '#111111',
} }) }));
jest.mock('../AppSystemBars', () => ({ useSystemBarsOverride: jest.fn() }));
jest.mock('../T', () => ({ __esModule: true, default: (props: any) => {
  const React = jest.requireActual('react');
  return React.createElement(jest.requireActual('react-native').Text, props, props.children);
} }));
jest.mock('expo-media-library', () => ({ requestPermissionsAsync: jest.fn(), saveToLibraryAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
  writeAsStringAsync: jest.fn(), readAsStringAsync: jest.fn(), deleteAsync: jest.fn(), downloadAsync: jest.fn(),
  StorageAccessFramework: {
    getUriForDirectoryInRoot: jest.fn(), requestDirectoryPermissionsAsync: jest.fn(), createFileAsync: jest.fn(),
  },
}));

const originalOS = Platform.OS;
const originalVersion = Platform.Version;
let view: ReactTestRenderer | undefined;

beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  Object.defineProperty(Platform, 'Version', { configurable: true, value: 28 });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (FileSystem.StorageAccessFramework.getUriForDirectoryInRoot as jest.Mock).mockReturnValue('content://pictures');
  (FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync as jest.Mock).mockResolvedValue({
    granted: true, directoryUri: 'content://chosen-folder',
  });
  (FileSystem.StorageAccessFramework.createFileAsync as jest.Mock).mockResolvedValue('content://saved-receipt');
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('aW1hZ2U=');
  (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
});

afterEach(() => {
  if (view) act(() => view!.unmount());
  view = undefined;
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  Object.defineProperty(Platform, 'Version', { configurable: true, value: originalVersion });
});

async function save(uri = 'file:///receipt.png') {
  await act(async () => { view = TestRenderer.create(<ReceiptViewer uri={uri} visible onClose={() => {}} />); });
  await act(async () => { await view!.root.find((node) => node.props.testID === 'receipt-save').props.onPress(); });
}

it.each([24, 28, 29, 32])('saves through a user-selected folder on API %s without storage permissions', async (version) => {
  Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
  await save();
  expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  expect(FileSystem.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
    'content://chosen-folder', expect.stringMatching(/^Splitora-receipt-/), 'image/png',
  );
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith('content://saved-receipt', 'aW1hZ2U=', { encoding: 'base64' });
  expect(Alert.alert).toHaveBeenCalledWith('Saved', 'Saved to your selected folder.');
});

it('returns cleanly when the older Android folder picker is cancelled', async () => {
  (FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  await save();
  expect(FileSystem.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
  expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(view!.root.find((node) => node.props.testID === 'receipt-save').props.disabled).toBe(false);
});

it('uses the streamed image MIME type and cleans downloaded cache after a folder save', async () => {
  (FileSystem.downloadAsync as jest.Mock).mockResolvedValue({ uri: 'file:///cache/download.jpg', status: 200,
    headers: { 'content-type': 'image/png' } });
  await save('https://qa.invalid/receipt');
  expect(FileSystem.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
    'content://chosen-folder', expect.any(String), 'image/png',
  );
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/receipt-/), { idempotent: true });
});

it('removes an incomplete scoped export when writing fails', async () => {
  (FileSystem.writeAsStringAsync as jest.Mock).mockRejectedValueOnce(new Error('Storage full'));
  await save();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('content://saved-receipt', { idempotent: true });
  expect(Alert.alert).toHaveBeenCalledWith('Error', 'Storage full');
});

it.each([33, 35])('saves directly to the gallery on API %s without requesting library permission', async (version) => {
  Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
  await save();
  expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(MediaLibrary.saveToLibraryAsync).toHaveBeenCalledWith('file:///receipt.png');
  expect(FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync).not.toHaveBeenCalled();
});

it('requests add-only photo permission on iOS and handles denial', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  await save();
  expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(true);
  expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  expect(FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync).not.toHaveBeenCalled();
});
