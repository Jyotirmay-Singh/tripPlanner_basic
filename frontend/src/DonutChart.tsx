import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import Svg, { G, Path, Circle, Text as SvgText } from 'react-native-svg';
import { useTheme } from './ThemeContext';
import T from './T';

export type DonutSlice = { key: string; label: string; value: number; color: string };

const PALETTE_LIGHT = ['#1C3F39', '#D4A373', '#6B8E6B', '#E05D3D', '#88B0A8', '#A48ED4', '#5C6B67'];
const PALETTE_DARK = ['#87C0B2', '#F5C28F', '#8FC98F', '#FF8A66', '#A8D4CC', '#C5B4F0', '#8EA39D'];

export function paletteForMode(mode: 'light' | 'dark') {
  return mode === 'dark' ? PALETTE_DARK : PALETTE_LIGHT;
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, endDeg: number) {
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const p1 = polar(cx, cy, rOuter, startDeg);
  const p2 = polar(cx, cy, rOuter, endDeg);
  const p3 = polar(cx, cy, rInner, endDeg);
  const p4 = polar(cx, cy, rInner, startDeg);
  return `M ${p1.x} ${p1.y} A ${rOuter} ${rOuter} 0 ${large} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rInner} ${rInner} 0 ${large} 0 ${p4.x} ${p4.y} Z`;
}

export default function DonutChart({
  data, size = 220, thickness = 36, centerLabel, centerValue, onSlicePress,
}: {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  onSlicePress?: (s: DonutSlice) => void;
}) {
  const { colors } = useTheme();
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const cx = size / 2, cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter - thickness;

  let cursor = 0;
  const slices = data.map((d) => {
    const start = (cursor / total) * 360;
    cursor += d.value;
    const end = (cursor / total) * 360;
    return { ...d, start, end };
  });

  return (
    <View style={styles.wrap}>
      <View>
        <Svg width={size} height={size}>
          <G>
            {slices.length === 1 ? (
              <>
                <Circle cx={cx} cy={cy} r={rOuter} fill={slices[0].color} />
                <Circle cx={cx} cy={cy} r={rInner} fill={colors.surface} />
              </>
            ) : (
              slices.map((s) => (
                <Path
                  key={s.key}
                  d={arcPath(cx, cy, rOuter, rInner, s.start, s.end)}
                  fill={s.color}
                  onPress={onSlicePress ? () => onSlicePress(s) : undefined}
                />
              ))
            )}
          </G>
          {centerValue ? (
            <SvgText x={cx} y={cy - 2} textAnchor="middle" fontSize="22" fontWeight="700" fill={colors.textMain}>
              {centerValue}
            </SvgText>
          ) : null}
          {centerLabel ? (
            <SvgText x={cx} y={cy + 18} textAnchor="middle" fontSize="11" fill={colors.textMuted}>
              {centerLabel.toUpperCase()}
            </SvgText>
          ) : null}
        </Svg>
      </View>
      <View style={styles.legend}>
        {data.map((d) => {
          const pct = total > 0 ? (d.value / total) * 100 : 0;
          return (
            <TouchableOpacity key={d.key} onPress={() => onSlicePress?.(d)} style={styles.legendRow}>
              <View style={[styles.dot, { backgroundColor: d.color }]} />
              <T variant="caption" style={{ flex: 1 }} numberOfLines={1}>{d.label}</T>
              <T variant="caption" muted>{pct.toFixed(0)}%</T>
              <T variant="caption" style={{ width: 70, textAlign: 'right' }}>{d.value.toFixed(2)}</T>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 12 },
  legend: { width: '100%', gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
