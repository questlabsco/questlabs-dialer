import { useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api';
import { demoApi } from '../api/demoApi';
import { Button, Input, IconAlert, Logo } from '../components/ui';
import { displayLogin, loginEmail } from '../lib/login';

/** Sample usernames to name under the form in demo mode: the first active admin and caller. */
function demoAccounts(): { username: string; role: string }[] {
  try {
    const users = [...demoApi.debugState().users].filter((u) => u.active).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const admin = users.find((u) => u.role === 'admin');
    const caller = users.find((u) => u.role === 'caller');
    return [admin, caller].filter((u): u is NonNullable<typeof u> => Boolean(u)).map((u) => ({ username: displayLogin(u.email), role: u.role }));
  } catch {
    return [];
  }
}

/** One ordinary sign-in form (username + password). The app routes by the signed-in profile's role. */
export default function Login() {
  const { signIn, isDemo } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const samples = useMemo(() => (isDemo ? demoAccounts() : []), [isDemo]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(loginEmail(username), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-box">
        <div className="login-head">
          <Logo size={32} title="Quest Labs" />
          <h1>Sign in to Quest Labs</h1>
        </div>

        <form className="form-stack login-form" onSubmit={submit} noValidate>
          {error && (
            <div className="form-error" role="alert">
              <IconAlert size={15} />
              <span>{error}</span>
            </div>
          )}
          <Input
            label="Username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <Input label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
            Sign in
          </Button>
        </form>

        {isDemo ? (
          samples.length > 0 && (
            <p className="login-note">
              Demo accounts:{' '}
              {samples.map((s, i) => (
                <span key={s.username}>
                  {i > 0 && ', '}
                  <button type="button" onClick={() => setUsername(s.username)} title={`Use ${s.username}`}>
                    {s.username}
                  </button>{' '}
                  ({s.role})
                </span>
              ))}
              . Any password works.
            </p>
          )
        ) : (
          <p className="login-note">Accounts are created by your admin.</p>
        )}
      </div>
    </main>
  );
}
