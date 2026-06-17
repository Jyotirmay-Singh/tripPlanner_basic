import React, { useState } from 'react';
import {
  Modal, View, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
// Step 20: legacy FS API gives a one-call native base64 -> file write, which the
// new File/Paths API can't do without manual base64 decoding. See plan.
import * as FileSystem from 'expo-file-system/legacy';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';
import { parseDataUri } from './receipt';

type Props = { uri: string | null; visible: boolean; onClose: () => void };

/**
 * Full-screen receipt viewer with a "Save to gallery" download trigger.
 * Reusable across the add/edit expense screens. The Save action is read-only
 * (available to any viewer); destructive receipt edits remain gated upstream.
 */
export default function ReceiptViewer({ uri, visible, onClose }: Props) {
  const { colors } = useTheme();
  const [saving, setSaving] = useState(false);

  const saveToGallery = async () => {
    if (!uri || saving) return;
    setSaving(true);
    let tempUri: string | null = null;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo access to save this receipt to your gallery.');
        return;
      }
      let fileUri = uri;
      if (uri.startsWith('data:')) {
        const parsed = parseDataUri(uri);
        if (!parsed) {
          Alert.alert('Error', "Couldn't read this receipt image.");
          return;
        }
        tempUri = `${FileSystem.cacheDirectory}receipt-${Date.now()}.${parsed.ext}`;
        await FileSystem.writeAsStringAsync(tempUri, parsed.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        fileUri = tempUri;
      }
      // Already a file:// / remote URI? saveToLibraryAsync handles it directly.
      await MediaLibrary.saveToLibraryAsync(fileUri);
      Alert.alert('Saved', 'Saved to your gallery.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || "Couldn't save the receipt.");
    } finally {
      if (tempUri) {
        try { await FileSystem.deleteAsync(tempUri, { idempotent: true }); } catch { /* best-effort */ }
      }
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Image lightboxes are conventionally dark in both themes for contrast;
          all chrome below uses theme tokens so it reads in light & dark mode. */}
      <View style={styles.backdrop}>
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          <View style={styles.topBar}>
            <TouchableOpacity testID="receipt-close" onPress={onClose}
              style={[styles.iconBtn, { backgroundColor: colors.surface }]}>
              <Ionicons name="close" size={22} color={colors.textMain} />
            </TouchableOpacity>
          </View>

          <View style={styles.imageWrap}>
            {uri ? (
              <Image source={{ uri }} style={styles.image} resizeMode="contain" />
            ) : (
              <T color={colors.primaryText}>No receipt to display.</T>
            )}
          </View>

          <View style={styles.bottomBar}>
            <TouchableOpacity testID="receipt-save" onPress={saveToGallery} disabled={!uri || saving}
              style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: !uri || saving ? 0.6 : 1 }]}>
              {saving ? (
                <ActivityIndicator color={colors.primaryText} />
              ) : (
                <>
                  <Ionicons name="download-outline" size={18} color={colors.primaryText} />
                  <T color={colors.primaryText} variant="h3">Save to gallery</T>
                </>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', padding: SPACING.md },
  iconBtn: { width: 40, height: 40, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
  imageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.md },
  image: { width: '100%', height: '100%' },
  bottomBar: { padding: SPACING.lg },
  saveBtn: {
    flexDirection: 'row', gap: SPACING.sm, paddingVertical: 16,
    borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center',
  },
});
