import { api } from './api';

export const COMMUNITY_TERMS_VERSION = '2026-11-13';
export const SUPPORT_EMAIL = 'teamsplitora@gmail.com';
export type CommunityAgeBand = 'under_13' | '13_17' | '18_plus';
export type CommunityPermissions = { account: boolean; chat: boolean; receipts: boolean; contacts: boolean };
export type GuardianControls = { chat_enabled: boolean; receipts_enabled: boolean; contacts_enabled: boolean };
export type CommunityState = {
  terms_version: string;
  accepted: boolean;
  age_band?: CommunityAgeBand | null;
  suspended: boolean;
  guardian_status?: string | null;
  guardian_email?: string | null;
  permissions: CommunityPermissions;
  blocks: { blocked_user_id: string; name: string }[];
  children: ({ id: string; name: string; status: string } & GuardianControls)[];
};
export type ReportTarget = { target_type: 'message' | 'receipt' | 'user'; target_id: string };
export type CommunityReportCase = ReportTarget & {
  id: string; trip_id: string; target_user_id?: string; snapshot?: string;
  reason: string; details: string; status: string; action?: string;
};

export const getCommunityState = () => api<CommunityState>('/auth/me/safety', { timeoutMs: 15_000 });
