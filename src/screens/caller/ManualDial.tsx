/**
 * "Call a number": a compact phone field + Call button for dialing one number by hand while the
 * dialer is idle or paused. Controlled by DialerView (the field outlives the idle -> connecting ->
 * idle round trip when a call cannot be placed, so its error stays visible).
 */
import { useId, type ClipboardEvent, type FormEvent } from 'react';
import { Button, IconPhone } from '../../components/ui';
import { MANUAL_INVALID_NUMBER_MESSAGE, normalizeUsPhone } from '../../dialer/engine';
import { formatPhone } from '../../lib/format';
import { formatPhoneAsTyped } from './dialerLogic';

export interface ManualDialProps {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  onError: (error: string | null) => void;
  calling: boolean;
  /** Called with a valid +1 number. */
  onCall: (e164: string) => void;
  /** Muted line under the field, e.g. how the last manual call ended. */
  note?: string | null;
  className?: string;
}

export function ManualDial({ value, onChange, error, onError, calling, onCall, note, className }: ManualDialProps) {
  const id = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (calling) return;
    const e164 = normalizeUsPhone(value);
    if (!e164) {
      onError(MANUAL_INVALID_NUMBER_MESSAGE);
      return;
    }
    onChange(formatPhone(e164));
    onError(null);
    onCall(e164);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const e164 = normalizeUsPhone(e.clipboardData.getData('text'));
    if (!e164) return;
    e.preventDefault();
    onChange(formatPhone(e164));
    onError(null);
  };

  const describedBy = error ? `${id}-error` : note ? `${id}-note` : undefined;

  return (
    <form className={`dl-manual ${className ?? ''}`.trim()} onSubmit={submit} noValidate aria-label="Call a number">
      <label className="field-label" htmlFor={id}>
        Call a number
      </label>
      <div className="dl-manual-row">
        <input
          id={id}
          className="input dl-manual-input"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="(214) 555-0123"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          readOnly={calling}
          onChange={(e) => {
            const el = e.target;
            // Reformat only while typing at the end, so editing in the middle keeps the caret.
            const atEnd = el.selectionStart === null || el.selectionStart === el.value.length;
            onChange(atEnd ? formatPhoneAsTyped(el.value) : el.value);
            if (error) onError(null);
          }}
          onBlur={() => {
            const e164 = normalizeUsPhone(value);
            if (e164) onChange(formatPhone(e164));
          }}
          onPaste={onPaste}
        />
        <Button type="submit" icon={<IconPhone size={14} />} loading={calling}>
          Call
        </Button>
      </div>
      {error ? (
        <div className="field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      ) : note ? (
        <div className="field-hint" id={`${id}-note`}>
          {note}
        </div>
      ) : null}
    </form>
  );
}
