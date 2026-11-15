import { useAuth } from './auth/AuthContext';
import { ForcedPasswordChange } from './auth/ChangePassword';
import { Spinner } from './components/ui';
import { AppShell } from './layout/AppShell';
import Login from './screens/Login';

export default function App() {
  const { profile, loading, mustChangePassword } = useAuth();
  if (loading) {
    return (
      <div className="center-fill">
        <Spinner size={28} label="Loading" />
      </div>
    );
  }
  if (!profile) return <Login />;
  // Signed in on a password an admin set: choose your own before the app opens.
  return mustChangePassword ? <ForcedPasswordChange /> : <AppShell />;
}
