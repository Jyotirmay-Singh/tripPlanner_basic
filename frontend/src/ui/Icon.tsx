import React from 'react';
import {
  Plane, Ship, User, UserRound, Users, Home, Briefcase, Plus, PlusCircle,
  ChevronRight, ChevronLeft, ChevronDown, LogOut, Check, CircleCheck, Trash2,
  Pencil, Share2, Image as ImageIcon, ImagePlus, Wallet, KeyRound, FileText,
  FileSpreadsheet, Lock, Shield, ShieldCheck, Settings, X, Moon, Sun,
  MoreVertical, ArrowLeftRight, Download, Camera, Mail, ArrowDown, ArrowUp,
  CircleAlert, Info, Receipt, Tag, Calendar, RefreshCw, Sparkles, Search,
  Circle, CircleDot, Square, SquareCheck, TrendingUp, TrendingDown,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme } from '../ThemeContext';
import { ICON_STROKE } from '../theme';

// Single source of truth mapping app-level semantic names to lucide glyphs, so screens
// reference `name="trash"` and the library swap stays here. design_guidelines.json mandates
// lucide with stroke-width 1.5.
const GLYPHS = {
  plane: Plane,
  ship: Ship,
  user: User,
  'user-round': UserRound,
  users: Users,
  home: Home,
  briefcase: Briefcase,
  plus: Plus,
  'plus-circle': PlusCircle,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  'chevron-down': ChevronDown,
  logout: LogOut,
  check: Check,
  'check-circle': CircleCheck,
  trash: Trash2,
  pencil: Pencil,
  share: Share2,
  image: ImageIcon,
  'image-plus': ImagePlus,
  wallet: Wallet,
  key: KeyRound,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  lock: Lock,
  shield: Shield,
  'shield-check': ShieldCheck,
  settings: Settings,
  close: X,
  moon: Moon,
  sun: Sun,
  'more-vertical': MoreVertical,
  'arrow-left-right': ArrowLeftRight,
  download: Download,
  camera: Camera,
  mail: Mail,
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  alert: CircleAlert,
  info: Info,
  receipt: Receipt,
  tag: Tag,
  calendar: Calendar,
  refresh: RefreshCw,
  sparkles: Sparkles,
  search: Search,
  circle: Circle,
  'radio-on': CircleDot,
  'radio-off': Circle,
  'checkbox-on': SquareCheck,
  'checkbox-off': Square,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof GLYPHS;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export default function Icon({ name, size = 22, color, strokeWidth = ICON_STROKE }: Props) {
  const { colors } = useTheme();
  const Glyph = GLYPHS[name];
  return <Glyph size={size} color={color || colors.textMain} strokeWidth={strokeWidth} />;
}
