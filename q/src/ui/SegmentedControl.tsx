import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  I18nManager,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useTheme } from '../ThemeContext';
import { FONTS, RADIUS, SPACING } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';

export type Segment<V extends string> = {
  value: V;
  label: string;
  icon?: IconName;
  badge?: string;
};

export type SegmentedControlLayout = 'equal' | 'scrollable' | 'adaptive';

type Props<V extends string> = {
  segments: Segment<V>[];
  value: V;
  onChange: (v: V) => void;
  /** Equal by default; adaptive uses equal widths only when every label genuinely fits. */
  layout?: SegmentedControlLayout;
  testIDPrefix?: string;
};

type ItemLayout = { x: number; width: number };

const TRACK_GAP = 4;
const TRACK_PADDING = 4;
const SCROLL_SEGMENT_PADDING = 14;
const EQUAL_SEGMENT_PADDING = SPACING.sm;

export function equalTrackRequiredWidth(itemWidths: number[]): number {
  if (itemWidths.length === 0) return 0;
  const equalMinimums = itemWidths.map((width) => (
    Math.max(0, width - (SCROLL_SEGMENT_PADDING * 2) + (EQUAL_SEGMENT_PADDING * 2))
  ));
  return (
    Math.max(...equalMinimums) * itemWidths.length
    + TRACK_GAP * Math.max(0, itemWidths.length - 1)
    + TRACK_PADDING * 2
    + 2
  );
}

export function selectedTabScrollOffset({
  item,
  viewportWidth,
  contentWidth,
  isRTL = false,
}: {
  item: ItemLayout;
  viewportWidth: number;
  contentWidth: number;
  isRTL?: boolean;
}): number {
  const maxOffset = Math.max(0, contentWidth - viewportWidth);
  const centered = Math.max(0, Math.min(maxOffset, item.x + item.width / 2 - viewportWidth / 2));
  return isRTL ? maxOffset - centered : centered;
}

/**
 * Pill segmented control used by form toggles and trip-detail navigation. Adaptive navigation
 * measures real rendered labels (including font scaling and badges), then chooses an equal track
 * or a standard horizontally scrollable track without changing the app's selected-pill styling.
 */
export default function SegmentedControl<V extends string>({
  segments,
  value,
  onChange,
  layout = 'equal',
  testIDPrefix,
}: Props<V>) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [itemLayouts, setItemLayouts] = useState<Record<string, ItemLayout>>({});
  const segmentSignature = useMemo(
    () => segments.map((segment) => (
      `${segment.value}:${segment.label}:${segment.icon ?? ''}:${segment.badge ?? ''}`
    )).join('|'),
    [segments],
  );

  useEffect(() => {
    setItemLayouts({});
    setContentWidth(0);
  }, [fontScale, segmentSignature]);

  const measuredWidths = segments
    .map((segment) => itemLayouts[segment.value]?.width)
    .filter((width): width is number => width !== undefined);
  const measurementsReady = measuredWidths.length === segments.length;
  const equalFits = measurementsReady
    && equalTrackRequiredWidth(measuredWidths) <= viewportWidth;
  const effectiveLayout: Exclude<SegmentedControlLayout, 'adaptive'> = layout === 'adaptive'
    ? equalFits ? 'equal' : 'scrollable'
    : layout;

  const recordItemLayout = useCallback((key: string) => (event: LayoutChangeEvent) => {
    if (effectiveLayout === 'equal') return;
    const { x, width } = event.nativeEvent.layout;
    setItemLayouts((current) => {
      const existing = current[key];
      if (existing?.x === x && existing.width === width) return current;
      return { ...current, [key]: { x, width } };
    });
  }, [effectiveLayout]);

  const keepSelectedVisible = useCallback((animated: boolean) => {
    if (effectiveLayout !== 'scrollable' || viewportWidth <= 0 || contentWidth <= 0) return;
    const selected = itemLayouts[value];
    if (!selected) return;
    scrollRef.current?.scrollTo({
      x: selectedTabScrollOffset({
        item: selected,
        viewportWidth,
        contentWidth,
        isRTL: I18nManager.isRTL,
      }),
      y: 0,
      animated,
    });
  }, [contentWidth, effectiveLayout, itemLayouts, value, viewportWidth]);

  useEffect(() => {
    keepSelectedVisible(true);
  }, [keepSelectedVisible]);

  const items = segments.map((segment) => {
    const active = segment.value === value;
    return (
      <Pressable
        key={segment.value}
        testID={testIDPrefix ? `${testIDPrefix}-${segment.value}` : undefined}
        onPress={() => onChange(segment.value)}
        onLayout={recordItemLayout(segment.value)}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        style={({ focused }: any) => [
          styles.segment,
          effectiveLayout === 'equal' ? styles.equalSegment : styles.scrollSegment,
          { backgroundColor: active ? colors.primary : 'transparent' },
          focused && Platform.OS === 'web' && {
            outlineWidth: 2,
            outlineColor: colors.primary,
            outlineStyle: 'solid',
          } as any,
        ]}
      >
        {segment.icon ? (
          <Icon
            name={segment.icon}
            size={15}
            color={active ? colors.primaryText : colors.textMuted}
          />
        ) : null}
        <T
          variant="caption"
          numberOfLines={1}
          style={{ fontFamily: FONTS.bodySemibold }}
          color={active ? colors.primaryText : colors.textMuted}
        >
          {segment.label}
        </T>
        {segment.badge ? (
          <View
            testID={testIDPrefix ? `${testIDPrefix}-${segment.value}-badge` : undefined}
            style={[
              styles.badge,
              { backgroundColor: active ? colors.primaryText : colors.primary },
            ]}
          >
            <T
              variant="caption"
              color={active ? colors.primary : colors.primaryText}
              style={styles.badgeText}
              numberOfLines={1}
            >
              {segment.badge}
            </T>
          </View>
        ) : null}
      </Pressable>
    );
  });

  const track = (
    <View
      testID={testIDPrefix ? `${testIDPrefix}-track` : undefined}
      style={[
        styles.track,
        effectiveLayout === 'equal' ? styles.equalTrack : styles.scrollTrack,
        { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
      ]}
    >
      {items}
    </View>
  );

  return (
    <View
      style={styles.root}
      onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
      testID={testIDPrefix ? `${testIDPrefix}-${effectiveLayout}` : undefined}
    >
      {effectiveLayout === 'scrollable' ? (
        <ScrollView
          ref={scrollRef}
          horizontal
          style={styles.scroller}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={(width) => setContentWidth(width)}
          keyboardShouldPersistTaps="handled"
        >
          {track}
        </ScrollView>
      ) : track}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', maxWidth: '100%' },
  scroller: { width: '100%', maxWidth: '100%', flexGrow: 0 },
  scrollContent: { flexGrow: 0 },
  track: {
    flexDirection: 'row',
    padding: TRACK_PADDING,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    gap: TRACK_GAP,
  },
  equalTrack: { width: '100%' },
  scrollTrack: { alignSelf: 'flex-start' },
  segment: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
  },
  equalSegment: { flex: 1, minWidth: 0, paddingHorizontal: EQUAL_SEGMENT_PADDING },
  scrollSegment: { flexGrow: 0, flexShrink: 0, paddingHorizontal: SCROLL_SEGMENT_PADDING },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: FONTS.bodySemibold, fontSize: 11, lineHeight: 14 },
});
