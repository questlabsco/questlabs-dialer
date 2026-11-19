import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ChangePasswordDialog } from '../auth/ChangePassword';
import { resetDemoData } from '../api/demoApi';
import { Avatar, ConfirmDialog, IconLock, IconLogout, IconRefresh, Logo, PageSectionContext, Spinner } from '../components/ui';
import { appVersion, isElectron, onUpdateStatus, openExternal, restartToUpdate, type UpdateStatus } from '../lib/desktop';
import { useDialer } from '../dialer/useDialer';
import { displayLogin } from '../lib/login';
import { NavigationContext, defaultScreen, navForRole, type NavigationValue, type ScreenKey, type ScreenParams } from './navigation';
import Dashboard from '../screens/admin/Dashboard';
import Leads from '../screens/admin/Leads';
import Team from '../screens/admin/Team';
import Numbers from '../screens/admin/Numbers';
import Recordings from '../screens/admin/Recordings';
import Settings from '../screens/admin/Settings';
import DialerScreen from '../screens/caller/DialerScreen';
import Callbacks from '../screens/caller/Callbacks';
import MyStats from '../screens/caller/MyStats';

const SCREENS: Record<ScreenKey, ComponentType> = {
  dashboard: Dashboard,
  leads: Leads,
  team: Team,
  numbers: Numbers,
  recordings: Recordings,
  settings: Settings,
  dialer: DialerScreen,
  callbacks: Callbacks,
  my_stats: MyStats,
};

/**
 * Sidebar notice for app updates. Nothing while up to date.
 * Windows: "Update ready" + Restart (installs and relaunches). macOS: "New version available" + Download (opens the releases page).
 */
function UpdateNotice({ role }: { role: string }) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'none' });
  useEffect(() => onUpdateStatus(setStatus), []);

  if (status.state === 'available') {
    return (
      <div className="sb-update" title={`Version ${status.version} is available`}>
        <span className="sb-update-label">New version available</span>
        <button type="button" className="sb-update-btn" aria-label={`Download version ${status.version}`} onClick={() => openExternal(status.url)}>
          Download
        </button>
      </div>
    );
  }
  if (status.state === 'ready') {
    // Callers may be on a call: only they use the dialer, so only they need the call guard.
    return role === 'caller' ? <CallerUpdateReady version={status.version} /> : <UpdateReady version={status.version} busy={false} />;
  }
  return null;
}

function CallerUpdateReady({ version }: { version: string }) {
  const { state } = useDialer();
  return <UpdateReady version={version} busy={state.phase === 'connected' || state.phase === 'wrap_up'} />;
}

function UpdateReady({ version, busy }: { version: string; busy: boolean }) {
  const [restarting, setRestarting] = useState(false);
  const restart = async () => {
    setRestarting(true);
    const ok = await restartToUpdate().catch(() => false);
    if (!ok) setRestarting(false);
  };
  const hint = busy ? 'Restart after this call to install the update' : `Version ${version} is ready. Restart to install it.`;
  return (
    <div className="sb-update" title={hint}>
      <span className="sb-update-label">{busy ? 'Update after call' : 'Update ready'}</span>
      <button type="button" className="sb-update-btn" aria-label={busy ? hint : `Restart to update to version ${version}`} disabled={busy || restarting} onClick={restart}>
        {restarting ? <Spinner size={12} /> : 'Restart'}
      </button>
    </div>
  );
}

function CallerNavigation({onCall}:{onCall:()=>void}) {
  const {state}=useDialer();
  const id=state.activeCall?.callId ?? state.incoming?.callId;
  useEffect(()=>{if(id) onCall();},[id,onCall]);
  return null;
}

/** Light sidebar (workspace, role-based navigation, demo tag, user) + the active screen. Rendered only when signed in. */
export function AppShell() {
  const { profile, isDemo, signOut } = useAuth();
  const role = profile?.role ?? 'caller';
  const items = navForRole(role);
  const [screen, setScreen] = useState<ScreenKey>(defaultScreen(role));
  const [params, setParams] = useState<ScreenParams>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  // Role changed (e.g. sign out/in as someone else): go to that role's home.
  useEffect(() => {
    setScreen(defaultScreen(role));
    setParams({});
  }, [role, profile?.id]);

  const navigate = useCallback(
    (next: ScreenKey, nextParams?: ScreenParams) => {
      if (!items.some((i) => i.key === next)) return;
      setScreen(next);
      setParams(nextParams ?? {});
    },
    [items],
  );

  const showDialer=useCallback(()=>setScreen('dialer'),[]);
  const nav = useMemo<NavigationValue>(() => ({ screen, params, navigate }), [screen, params, navigate]);
  const allowed = items.some((i) => i.key === screen) ? screen : defaultScreen(role);
  const Screen = SCREENS[allowed];

  const signOutNow = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  // Page headers are typographic; no section icon is provided any more.
  const section = useMemo(() => ({}), []);

  return (
    <NavigationContext.Provider value={nav}>
      {role==='caller' && <CallerNavigation onCall={showDialer}/>}
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sb-workspace" title={`Quest Labs Dialer, version ${appVersion}`}>
            <Logo size={22} />
            <div className="sb-workspace-text">
              <span className="sb-workspace-name">Quest Labs</span>
              <span className="sb-workspace-sub">{role === 'admin' ? 'Dialer · Admin' : 'Dialer · Caller'}</span>
            </div>
          </div>
          <nav className="sb-nav" aria-label="Main">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.key} type="button" className="sb-item" title={item.label} aria-current={allowed === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}>
                  <Icon size={16} strokeWidth={1.6} />
                  <span className="sb-item-label">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="sb-foot">
            {isDemo && (
              <div className="sb-demo" title="Sample data and simulated calls on this computer only">
                <span className="sb-demo-label">Demo data</span>
                <button type="button" className="sb-icon-btn" aria-label="Reset demo data" title="Reset demo data" onClick={() => setConfirmReset(true)}>
                  <IconRefresh size={14} strokeWidth={1.6} />
                </button>
              </div>
            )}
            <UpdateNotice role={role} />
            {isElectron && (
              <div className="sb-version" title={`Quest Labs Dialer, version ${appVersion}`}>
                Version {appVersion}
              </div>
            )}
            <div className="sb-user">
              <Avatar name={profile?.fullName ?? '?'} size={24} />
              <div className="who">
                <span className="name" title={profile?.fullName}>
                  {profile?.fullName}
                </span>
                <span className="role" title={profile ? displayLogin(profile.email) : undefined}>
                  {profile ? displayLogin(profile.email) : ''}
                </span>
              </div>
              <button type="button" className="sb-icon-btn" aria-label="Change password" title="Change password" onClick={() => setChangingPassword(true)}>
                <IconLock size={15} strokeWidth={1.6} />
              </button>
              <button type="button" className="sb-icon-btn" aria-label="Sign out" title="Sign out" disabled={signingOut} onClick={signOutNow}>
                {signingOut ? <Spinner size={14} /> : <IconLogout size={15} strokeWidth={1.6} />}
              </button>
            </div>
          </div>
        </aside>

        <main className="main" id="main">
          <PageSectionContext.Provider value={section}>
            <Screen key={allowed} />
          </PageSectionContext.Provider>
        </main>
      </div>

      <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} />

      <ConfirmDialog
        open={confirmReset}
        title="Reset demo data?"
        message="Leads, calls, numbers and settings go back to the sample data. Affects this computer only."
        confirmLabel="Reset"
        danger
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          resetDemoData();
          window.location.reload();
        }}
      />
    </NavigationContext.Provider>
  );
}
