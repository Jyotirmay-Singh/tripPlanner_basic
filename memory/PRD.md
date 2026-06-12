# Trip Expense Splitter — PRD

## Overview
Mobile (Expo React Native) + FastAPI + MongoDB app for sharing trip expenses, tracking who owes whom, settling up, budgeting, and exporting reports.

## Tech
- Frontend: Expo SDK 54, expo-router, React Native StyleSheet, @react-native-async-storage/async-storage, expo-image-picker
- Backend: FastAPI, Motor (MongoDB async), bcrypt, PyJWT, openpyxl, emergentintegrations (Claude Sonnet 4.5)
- Auth: JWT Bearer tokens (30 days), AsyncStorage on mobile
- Theme: light/dark, user-toggleable (Archetype Organic & Earthy)

## Features (MVP)
1. **Auth** — Email+Password+4-digit PIN registration, Email+Password login, PIN-only quick login, Forgot password (token logged to backend logs when email not configured), Reset password.
2. **Trips** — CRUD, unique 6-char share code, join-by-code, multi-user collab (`user_ids` array).
3. **Members** — Add individual or family (family has `family_members[]` names; expenses are weight-split per family-member count).
4. **Expenses/Income** — Amount, category (required dropdown: Travel, Accommodation, Local Transportation, Local Sightseeing, Food, Shopping, Other), description, DD-MM-YY date, paid-by, split all/selected, optional base64 receipt.
5. **Budget** — Over-budget warning modal with Save-anyway `force=true` bypass.
6. **Balances & Settle Up** — Greedy minimum-transactions algorithm, record settlements.
7. **Reports** — JSON summary + XLSX download (Summary / By Category / Per Member / Transactions sheets).
8. **AI** — Auto-categorize expense descriptions + generate 3-bullet insights per trip (Claude Sonnet 4.5 via EMERGENT_LLM_KEY).
9. **Dark mode** toggle in Profile.
10. **Receipt image** via gallery picker (base64).

## Nav
- Tabs: Dashboard · Trips · Add · Reports · Profile
- Stack modals: Create Trip, Join Trip, Add Member, Add Transaction, Edit Trip
- Stack: Trip Detail, Settle Up

## Not in MVP (future)
- Live FX conversion
- Push notifications
- PDF share
- Role-based access (Admin vs Member) — simple owner-only delete implemented
- Offline sync
