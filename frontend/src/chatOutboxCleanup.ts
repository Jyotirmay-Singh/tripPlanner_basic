import AsyncStorage from '@react-native-async-storage/async-storage';

export async function purgeAccountChatOutbox(accountId: string): Promise<void> {
  const prefix = `trip_chat_outbox:v1:${accountId}:`;
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}
