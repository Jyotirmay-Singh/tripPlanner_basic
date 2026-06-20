import React, { useCallback, useState } from 'react';
import { View, Linking } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api, getToken } from '../../src/api';
import T from '../../src/T';
import { Screen, Card, Button, EmptyState, SkeletonCard, useToast } from '../../src/ui';

type Trip = { id: string; name: string; currency: string };

export default function Reports() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setTrips(await api<Trip[]>('/trips')); } catch {}
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openXlsx = async (tripId: string) => {
    const token = await getToken();
    if (!token) return;
    const base = process.env.EXPO_PUBLIC_BACKEND_URL;
    try {
      await Linking.openURL(`${base}/api/trips/${tripId}/report.xlsx?token=${encodeURIComponent(token)}`);
    } catch {
      toast.show('Could not open the report. Try again.', 'error');
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={load}>
      <T variant="h1">Reports</T>
      <T muted>Download an XLSX expense report for any trip.</T>

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="spreadsheet"
          title="Nothing to report yet"
          body="Once you have a trip with expenses, you can export it as a spreadsheet here."
          testID="reports-empty"
        />
      ) : (
        trips.map((t) => (
          <Card key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T variant="h4" numberOfLines={1}>{t.name}</T>
              <T muted variant="caption">{t.currency}</T>
            </View>
            <Button label="XLSX" icon="download" size="sm" onPress={() => openXlsx(t.id)} testID={`report-xlsx-${t.id}`} />
          </Card>
        ))
      )}
    </Screen>
  );
}
