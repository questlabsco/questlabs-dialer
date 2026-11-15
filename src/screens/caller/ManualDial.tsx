/**
 * The dial pad.
 *
 * `ManualDial`: number field on top, digit keys below, Call at the bottom. Dials one number by hand
 * while the dialer is idle or paused. Controlled by DialerView (the field outlives the
 * idle -> connecting -> idle round trip when a call cannot be placed, so its error stays visible).
 *
 * `TonePad`: the same keys during a live call. Each key sends its tone down the line, for phone
 * menus ("press 1 for sales").
 */
import { useId, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { Button, IconPhone } from '../../components/ui';
import { MANUAL_INVALID_NUMBER_MESSAGE, normalizeUsPhone } from '../../dialer/engine';
import { formatPhone } from '../../lib/format';
import { formatPhoneAsTyped } from './dialerLogic';

const PAD_KEYS: readonly { key: string; letters: string }[] = [
  { key: '1', letters: '' },
  { key: '2', letters: 'ABC' },
  { key: '3', letters: 'DEF' },
  { key: '4', letters: 'GHI' },
  { key: '5', letters: 'JKL' },
  { key: '6', letters: 'MNO' },
  { key: '7', letters: 'PQRS' },
  { key: '8', letters: 'TUV' },
  { key: '9', letters: 'WXYZ' },
  { key: '*', letters: '' },
  { key: '0', letters: '' },
  { key: '#', letters: '' },
];

function PadKeys({ onKey, disabled, disabledKeys = [] }: { onKey: (key: string) => void; disabled?: boolean; disabledKeys?: readonly string[] }) {
  return (
    <div className="dl-pad-keys">
      {PAD_KEYS.map(({ key, letters }) => (
        <button
          key={key}
          type="button"
          className="dl-pad-key"
          disabled={disabled || disabledKeys.includes(key)}
          aria-label={key === '*' ? 'Star' : key === '#' ? 'Pound' : key}
          onClick={() => onKey(key)}
        >
          <span className="dl-pad-digit">{key}</span>
          <span className="dl-pad-letters" aria-hidden="true">
            {letters}
          </span>
        </button>
      ))}
    </div>
  );
}

export interface ManualDialProps {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  onError: (error: string | null) => void;
  calling: boolean;
  /** Called with a valid +1 number. */
  onCall: (e164: string) => void;
  /** Muted line under the pad, e.g. how the last manual call ended. */
  note?: string | null;
  className?: string;
}

export function ManualDial({ value, onChange, error, onError, calling, onCall, note, className }: ManualDialProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);

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

  const press = (key: string) => {
    if (calling) return;
    onChange(formatPhoneAsTyped(value + key));
    if (error) onError(null);
    input.current?.focus();
  };

  const deleteLast = () => {
    if (calling) return;
    onChange(formatPhoneAsTyped(value.replace(/\D/g, '').slice(0, -1)));
    if (error) onError(null);
    input.current?.focus();
  };

  const describedBy = error ? `${id}-error` : note ? `${id}-note` : undefined;

  return (
    <form className={`dl-pad ${className ?? ''}`.trim()} onSubmit={submit} noValidate aria-label="Dial pad">
      <label className="dl-pad-title" htmlFor={id}>
        Dial pad
      </label>
      <div className="dl-pad-entry">
        <input
          id={id}
          ref={input}
          className="input dl-pad-input"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="Type a number"
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
        <button type="button" className="dl-pad-del" onClick={deleteLast} disabled={calling || !value} aria-label="Delete last digit">
          Del
        </button>
      </div>
      {/* Star and pound only mean something during a call. */}
      <PadKeys onKey={press} disabled={calling} disabledKeys={['*', '#']} />
      <Button type="submit" variant="primary" size="lg" fullWidth icon={<IconPhone size={15} />} loading={calling}>
        Call
      </Button>
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

/** Keys that send tones down a live call (phone menus). */
export function TonePad({ onDigit, className }: { onDigit: (digit: string) => void; className?: string }) {
  const [sent, setSent] = useState('');
  return (
    <section className={`dl-pad ${className ?? ''}`.trim()} aria-label="Keypad">
      <div className="dl-pad-title">Keypad</div>
      <div className="dl-pad-sent" aria-live="polite">
        {sent || <span className="dl-pad-sent-empty">Press keys for phone menus</span>}
      </div>
      <PadKeys
        onKey={(key) => {
          setSent((s) => (s + key).slice(-24));
          onDigit(key);
        }}
      />
    </section>
  );
}
