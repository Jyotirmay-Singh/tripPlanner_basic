import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../ThemeContext';
import { FONTS } from '../theme';
import { CATEGORY_SECTIONS, categoryLayout, searchCategories, type CategoryName } from '../categories';
import T from '../T';
import Icon from './Icon';
import CategoryBadge from './CategoryBadge';
import Sheet from './Sheet';

export default function CategoryPicker({ value, onChange, disabled = false, testID = 'category-picker' }: {
  value: string; onChange: (value: CategoryName) => void; disabled?: boolean; testID?: string;
}) {
  const { colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [contentWidth, setContentWidth] = useState(Math.min(width, 640) - 48);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);
  const trigger = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const selected = useRef<View>(null);
  const results = useMemo(() => searchCategories(query), [query]);
  const searching = query.trim().length > 0;
  const layout = categoryLayout(contentWidth, fontScale);
  const list = searching || layout === 'list';
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    if (!open || !searching) return;
    const timer = setTimeout(() => {
      const text = `${results.length} ${results.length === 1 ? 'category' : 'categories'} found`;
      setAnnouncement(text);
      if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(text);
    }, 250);
    return () => clearTimeout(timer);
  }, [open, results.length, searching]);
  const close = () => {
    Keyboard.dismiss(); setOpen(false); setQuery(''); setAnnouncement(''); setSearchFocused(false);
    if (Platform.OS !== 'web') focusTimer.current = setTimeout(() => {
      const node = findNodeHandle(trigger.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 0);
  };
  const back = () => { if (keyboardVisible) Keyboard.dismiss(); else close(); };
  const revealSelected = () => {
    if (searching) return;
    if (Platform.OS === 'web') {
      (selected.current as unknown as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
    } else if (content.current && selected.current) {
      selected.current.measureLayout(content.current, (_x, y) => scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: false }), () => {});
    }
  };
  const option = (category: typeof results[number]) => {
    const checked = value === category.name;
    return <Pressable key={category.name} ref={checked ? selected : undefined}
      testID={`${testID}-option-${category.name}`} accessibilityRole="radio"
      accessibilityLabel={category.name} aria-checked={checked} accessibilityState={{ selected: checked, checked }}
      onPress={() => { onChange(category.name); close(); }}
      style={({ focused }: any) => [styles.option, list ? styles.listOption : styles.tile,
        { backgroundColor: colors.surface, borderColor: checked ? colors.primary : colors.textMuted,
          borderWidth: checked ? 2 : 1 },
        focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any]}>
      <CategoryBadge name={category.name} size={list ? 22 : 24} />
      <View style={list ? { flex: 1, minWidth: 0 } : { width: '100%' }}>
        <T style={{ fontFamily: checked ? FONTS.bodySemibold : FONTS.bodyMedium, fontSize: list ? 16 : 14 }}>{category.name}</T>
        {searching ? <T variant="caption" muted style={{ fontSize: 13 }}>{category.section}</T> : null}
      </View>
      {checked ? <View style={list ? undefined : styles.tileCheck} accessible={false}><Icon name="check" size={20} color={colors.primary} /></View> : null}
    </Pressable>;
  };
  const grouped = CATEGORY_SECTIONS.map((section) => {
    const categories = results.filter((category) => category.section === section);
    const columns = layout === 'list' ? 1 : layout;
    const rows = Array.from({ length: Math.ceil(categories.length / columns) }, (_, i) => categories.slice(i * columns, (i + 1) * columns));
    return <View key={section} style={{ gap: 8, marginBottom: 24 }}>
      <T style={{ fontFamily: FONTS.bodySemibold, fontSize: 14, marginBottom: 4 }}>{section}</T>
      {rows.map((row, i) => <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'stretch' }}>
        {row.map((category) => <View key={category.name} style={{ flex: 1, minWidth: 0 }}>{option(category)}</View>)}
        {Array.from({ length: columns - row.length }, (_, j) => <View key={`space-${j}`} style={{ flex: 1 }} />)}
      </View>)}
    </View>;
  });
  return <>
    <Pressable ref={trigger} testID={testID} disabled={disabled} accessibilityRole="button"
      accessibilityLabel={`Category, ${value}`} accessibilityHint="Opens category chooser" aria-expanded={open} aria-disabled={disabled} accessibilityState={{ disabled, expanded: open }}
      onPress={() => { Keyboard.dismiss(); setOpen(true); if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility('Choose category'); }}
      style={({ focused }: any) => [styles.trigger, { backgroundColor: colors.surface, borderColor: colors.textMuted, opacity: disabled ? 0.5 : 1 },
        focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any]}>
      <CategoryBadge name={value} /><T style={{ flex: 1, minWidth: 0, fontFamily: FONTS.bodyMedium, fontSize: 16 }}>{value}</T>
      <Icon name="chevron-down" size={20} color={colors.textMuted} />
    </Pressable>
    <Sheet visible={open} onClose={close} onRequestClose={back} title="Choose category" closeLabel="Close category chooser"
      touchSize={48} restrainedMotion trapFocus testID={`${testID}-sheet`} closeTestID={`${testID}-close`} scrimTestID={`${testID}-scrim`}>
      <View onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)} style={{ flexShrink: 1 }}>
        <View style={[styles.search, { backgroundColor: colors.surfaceMuted, borderColor: searchFocused ? colors.primary : colors.textMuted, borderWidth: searchFocused ? 2 : 1 }]}>
          <View accessible={false}><Icon name="search" size={20} color={colors.textMuted} /></View>
          <TextInput testID={`${testID}-search`} accessibilityLabel="Search categories" placeholder="Search categories"
            onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
            placeholderTextColor={colors.textMuted} value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none"
            style={{ flex: 1, minWidth: 0, minHeight: 48, fontFamily: FONTS.body, fontSize: 16, color: colors.textMain, ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}) }} />
          {query ? <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear category search" testID={`${testID}-clear`}
            style={({ focused }: any) => [{ width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid' } as any]}><Icon name="close" size={18} /></Pressable> : null}
        </View>
        {searching ? <T variant="caption" muted accessibilityLiveRegion="polite" style={{ marginVertical: 8 }}>{announcement}</T> : null}
        <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" onContentSizeChange={revealSelected} style={{ flexShrink: 1 }}>
          <View ref={content} style={{ paddingTop: 16, paddingBottom: 8 }}>
            {searching ? results.length ? <View style={{ gap: 8 }}>{results.map(option)}</View> : <View style={{ gap: 8, paddingVertical: 24 }}>
              <T variant="h3">No categories found</T><T muted>Try another name, such as taxi or groceries.</T>
              <Pressable onPress={() => setQuery('')} accessibilityRole="button" style={({ focused }: any) => [{ minHeight: 48, justifyContent: 'center' }, focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid' } as any]}><T color={colors.primary}>Clear search</T></Pressable>
            </View> : grouped}
          </View>
        </ScrollView>
      </View>
    </Sheet>
  </>;
}
const styles = StyleSheet.create({
  trigger: { minHeight: 56, borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingLeft: 12, minHeight: 48 },
  option: { borderRadius: 12, padding: 12, gap: 8, position: 'relative' },
  tile: { minHeight: 96, flex: 1, alignItems: 'flex-start' },
  listOption: { minHeight: 64, flexDirection: 'row', alignItems: 'center' },
  tileCheck: { position: 'absolute', top: 12, right: 12 },
});
