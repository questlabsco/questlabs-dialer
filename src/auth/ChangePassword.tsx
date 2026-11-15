import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api';
import { Button, Checkbox, IconAlert, Input, Logo, Modal, useToast } from '../components/ui';
import { PASSWORD_MESSAGES, hasErrors, validatePasswordChange, type PasswordChangeErrors } from '../lib/password';
import { useAuth } from './AuthContext';

const NEXT_FIELD_MESSAGES: string[] = [PASSWORD_MESSAGES.tooShort, PASSWORD_MESSAGES.sameAsCurrent, PASSWORD_MESSAGES.required];

/** Form state + submit shared by the forced step and the dialog. Values live only in component state. */
function usePasswordForm(opts: { askCurrent: boolean; onDone: () => void }) {
  const { changeMyPassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<PasswordChangeErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setShow(false);
    setErrors({});
    setFormError(null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setFormError(null);
    // Without a current-password field the held sign-in password is used; the API compares against it.
    const found = validatePasswordChange({ current: opts.askCurrent ? current : undefined, next, confirm });
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      await changeMyPassword({ currentPassword: opts.askCurrent ? current : undefined, newPassword: next });
      reset();
      opts.onDone();
    } catch (err) {
      const msg = errorMessage(err);
      if (msg === PASSWORD_MESSAGES.currentWrong && opts.askCurrent) setErrors({ current: msg });
      else if (NEXT_FIELD_MESSAGES.includes(msg)) setErrors({ next: msg });
      else setFormError(msg);
    } finally {
      setBusy(false);
    }
  };

  const type = show ? 'text' : 'password';
  const fields = (
    <>
      {formError && (
        <div className="form-error" role="alert">
          <IconAlert size={15} />
          <span>{formError}</span>
        </div>
      )}
      {opts.askCurrent && (
        <Input
          label="Current password"
          name="current-password"
          type={type}
          autoComplete="current-password"
          value={current}
          error={errors.current}
          onChange={(e) => setCurrent(e.target.value)}
          data-autofocus
          autoFocus
        />
      )}
      <Input
        label="New password"
        name="new-password"
        type={type}
        autoComplete="new-password"
        value={next}
        hint="At least 8 characters"
        error={errors.next}
        onChange={(e) => setNext(e.target.value)}
        data-autofocus={opts.askCurrent ? undefined : true}
        autoFocus={!opts.askCurrent}
      />
      <Input
        label="Confirm new password"
        name="confirm-password"
        type={type}
        autoComplete="new-password"
        value={confirm}
        error={errors.confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <Checkbox label="Show passwords" checked={show} onChange={setShow} />
    </>
  );

  return { fields, submit, busy, reset };
}

/** Full-screen step after signing in on a password an admin set. Replaces the app until done. */
export function ForcedPasswordChange() {
  const { hasHeldPassword, signOut } = useAuth();
  const toast = useToast();
  // Decided once: the held password is cleared on success, and the form must not change shape meanwhile.
  const [askCurrent] = useState(() => !hasHeldPassword());
  const [signingOut, setSigningOut] = useState(false);
  const form = usePasswordForm({ askCurrent, onDone: () => toast.success('Password changed') });

  const leave = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <main className="login">
      <div className="login-box">
        <div className="login-head">
          <Logo size={32} title="Quest Labs" />
          <div className="login-title">
            <h1>Choose a new password</h1>
            <p className="login-sub">{askCurrent ? 'Your admin set a temporary password. Enter it, then choose your own.' : 'Your admin set a temporary password. Choose your own to continue.'}</p>
          </div>
        </div>
        <form className="form-stack login-form" onSubmit={form.submit} noValidate>
          {form.fields}
          <Button type="submit" variant="primary" size="lg" fullWidth loading={form.busy}>
            Save and continue
          </Button>
        </form>
        <p className="login-note">
          <button type="button" onClick={leave} disabled={signingOut}>
            Sign out
          </button>
        </p>
      </div>
    </main>
  );
}

/** "Change password" dialog opened from the sidebar. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const form = usePasswordForm({
    askCurrent: true,
    onDone: () => {
      toast.success('Password changed');
      onClose();
    },
  });
  const close = () => {
    form.reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Change password"
      size="sm"
      dismissible={!form.busy}
      footer={
        <>
          <Button onClick={close} disabled={form.busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={form.busy} onClick={() => void form.submit()}>
            Change password
          </Button>
        </>
      }
    >
      <form className="form-stack" onSubmit={form.submit} noValidate>
        {form.fields}
        {/* Enter in a field submits. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
