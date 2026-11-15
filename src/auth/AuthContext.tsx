import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, isDemo } from '../api';
import { resetDialerEngine } from '../dialer/useDialer';
import type { Profile, Role } from '../types';

export interface AuthValue {
  /** Signed-in user, or null. */
  profile: Profile | null;
  /** True until the initial session check finishes. */
  loading: boolean;
  isDemo: boolean;
  isAdmin: boolean;
  signIn(email: string, password: string): Promise<Profile>;
  /** Demo mode only. */
  signInDemo(role: Role): Promise<Profile>;
  /** Stops the dialer, releases locks, signs out. */
  signOut(): Promise<void>;
  /** Re-reads the profile (e.g. after editing your own name). */
  refresh(): Promise<void>;
  /** Signed in on a password an admin set: the app shows "Choose a new password" instead of the shell. */
  mustChangePassword: boolean;
  /**
   * True while the temporary password typed at sign-in is held in memory (this tab only, never
   * stored), so the forced step need not ask for it again.
   */
  hasHeldPassword(): boolean;
  /**
   * Changes my password. `currentPassword` may be omitted only when `hasHeldPassword()` is true.
   * Clears the must-change flag and the held password on success.
   */
  changeMyPassword(input: { currentPassword?: string; newPassword: string }): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  /** The password just typed at sign-in, kept only while a forced change is pending. */
  const heldPassword = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (p: Profile | null) => {
      setProfile(p);
      const must = p ? api.mustChangePassword() : false;
      setMustChangePassword(must);
      if (!must) heldPassword.current = null;
    };
    api
      .getSession()
      .then((p) => {
        if (alive) apply(p);
      })
      .catch(() => {
        if (alive) apply(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const unsub = api.onAuthChange(apply);
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    // Held before the call: the profile listener may render the forced step before this resolves.
    heldPassword.current = password;
    try {
      const p = await api.signIn(email, password);
      const must = api.mustChangePassword();
      if (!must) heldPassword.current = null;
      setMustChangePassword(must);
      return p;
    } catch (e) {
      heldPassword.current = null;
      throw e;
    }
  }, []);
  const signInDemo = useCallback((role: Role) => api.signInDemo(role), []);
  const signOut = useCallback(async () => {
    heldPassword.current = null;
    await resetDialerEngine();
    await api.signOut();
  }, []);
  const refresh = useCallback(async () => {
    setProfile(await api.getSession());
  }, []);
  const hasHeldPassword = useCallback(() => heldPassword.current !== null, []);
  const changeMyPassword = useCallback(async (input: { currentPassword?: string; newPassword: string }) => {
    const currentPassword = input.currentPassword ?? heldPassword.current ?? '';
    await api.changeMyPassword({ currentPassword, newPassword: input.newPassword });
    heldPassword.current = null;
    setMustChangePassword(api.mustChangePassword());
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      profile,
      loading,
      isDemo,
      isAdmin: profile?.role === 'admin',
      signIn,
      signInDemo,
      signOut,
      refresh,
      mustChangePassword,
      hasHeldPassword,
      changeMyPassword,
    }),
    [profile, loading, signIn, signInDemo, signOut, refresh, mustChangePassword, hasHeldPassword, changeMyPassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
