/** In-memory routing: a screen key plus optional params. No router library. */
import { createContext, useContext, type ComponentType } from 'react';
import {
  IconCallback,
  IconDashboard,
  IconDialer,
  IconLeads,
  IconPhone,
  IconRecordings,
  IconSettings,
  IconStats,
  IconTeam,
  type IconProps,
} from '../components/ui/icons';
import type { Role } from '../types';

export type AdminScreen = 'dashboard' | 'leads' | 'team' | 'numbers' | 'recordings' | 'settings';
export type CallerScreen = 'dialer' | 'callbacks' | 'my_stats';
export type ScreenKey = AdminScreen | CallerScreen;

/** Optional string params passed with navigate(), e.g. navigate('leads', { leadId }). */
export type ScreenParams = Record<string, string>;

export interface NavItem {
  key: ScreenKey;
  label: string;
  icon: ComponentType<IconProps>;
  /** Section heading this item belongs to (not shown in the header bar). */
  group?: string;
  /** Colour of the section's icon tile in the page header. */
  color?: string;
}

// Object colours, one per section (white icon on each passes 4.5:1).
export const ADMIN_NAV: readonly NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: IconDashboard, group: 'Overview', color: '#2f62c4' },
  { key: 'leads', label: 'Leads', icon: IconLeads, group: 'Sales', color: '#c0561b' },
  { key: 'recordings', label: 'Recordings', icon: IconRecordings, group: 'Sales', color: '#0b7468' },
  { key: 'team', label: 'Team', icon: IconTeam, group: 'Workspace', color: '#4a5a78' },
  { key: 'numbers', label: 'Numbers', icon: IconPhone, group: 'Workspace', color: '#9b2f63' },
  { key: 'settings', label: 'Settings', icon: IconSettings, group: 'Workspace', color: '#55606f' },
];

export const CALLER_NAV: readonly NavItem[] = [
  { key: 'dialer', label: 'Dialer', icon: IconDialer, group: 'Calling', color: '#0d7346' },
  { key: 'callbacks', label: 'Callbacks', icon: IconCallback, group: 'Calling', color: '#9a5b00' },
  { key: 'my_stats', label: 'My stats', icon: IconStats, group: 'Performance', color: '#2f62c4' },
];

export function navForRole(role: Role): readonly NavItem[] {
  return role === 'admin' ? ADMIN_NAV : CALLER_NAV;
}

export function defaultScreen(role: Role): ScreenKey {
  return role === 'admin' ? 'dashboard' : 'dialer';
}

export interface NavigationValue {
  screen: ScreenKey;
  params: ScreenParams;
  /** Switch screen. Keys not allowed for the current role are ignored. */
  navigate(screen: ScreenKey, params?: ScreenParams): void;
}

export const NavigationContext = createContext<NavigationValue | null>(null);

/** `const { screen, params, navigate } = useNavigation();` */
export function useNavigation(): NavigationValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used inside <AppShell>.');
  return ctx;
}
