import { useEffect, useRef, useState } from 'react';
import { Badge, Button, IconDialer, IconMic, IconMicOff, IconPhoneOff } from '../../components/ui';
import type { ActiveCall } from '../../dialer/types';
import { formatDuration, formatPhone } from '../../lib/format';
import { BookMeetingButton } from './Booking';
import { isUnknownLead, secondsSince } from './dialerLogic';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function Keypad({ onDigit, onClose }: { onDigit: (d: string) => void; onClose: (returnFocus: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onDown = (e: MouseEvent) => {
      // The anchor holds the Keypad toggle button too; clicks there are handled by the toggle.
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onCloseRef.current(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const press = (d: string) => {
    setTyped((t) => (t + d).slice(-16));
    onDigit(d);
  };

  return (
    <div
      ref={ref}
      className="dl-keypad"
      role="dialog"
      aria-label="Keypad"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        } else if (/^[0-9*#]$/.test(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          press(e.key);
        }
      }}
    >
      <div className="dl-keypad-display mono" aria-live="polite">
        {typed || <span className="muted">Tones</span>}
      </div>
      <div className="dl-keypad-grid">
        {KEYS.map((k) => (
          <button key={k} type="button" className="btn btn-secondary dl-key" onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface CallBarProps {
  call: ActiveCall;
  businessName: string;
  contactName: string;
  /** The lead's current email (including edits made during the call); used to prefill the booking. */
  email?: string;
  now: number;
  onToggleMute: () => void;
  onHangUp: () => void;
  onDigit: (d: string) => void;
  hangingUp: boolean;
}

/** The live call bar: who, timer, mute, keypad, book meeting, hang up. */
export function CallBar({ call, businessName, contactName, email = '', now, onToggleMute, onHangUp, onDigit, hangingUp }: CallBarProps) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  const keypadBtn = useRef<HTMLButtonElement>(null);
  const unknown = isUnknownLead(call.lead);
  const otherParty = call.direction === 'inbound' ? call.fromNumber : call.toNumber;
  const title = unknown ? formatPhone(otherParty) : businessName || formatPhone(otherParty);
  const sub = unknown ? (call.manual ? 'Not in your leads' : 'Unknown caller') : [contactName, formatPhone(otherParty)].filter(Boolean).join(' · ');

  const closeKeypad = (returnFocus: boolean) => {
    setKeypadOpen(false);
    if (returnFocus) keypadBtn.current?.focus();
  };

  return (
    <section className="dl-callbar" aria-label="Active call">
      <div className="dl-callbar-who">
        <div className="row dl-wrap dl-callbar-status">
          <span className="dl-callbar-state">Connected</span>
          {call.direction === 'inbound' && <Badge tone="accent">Incoming call</Badge>}
          {call.manual && <Badge>Manual call</Badge>}
          {call.muted && <Badge tone="warning">Muted</Badge>}
        </div>
        <div className="dl-callbar-title">{title}</div>
        <div className="dl-callbar-sub">{sub}</div>
      </div>
      <div className="dl-callbar-timer mono" aria-label="Call time">
        {formatDuration(secondsSince(call.answeredAt, now))}
      </div>
      <div className="dl-callbar-actions">
        <Button
          variant={call.muted ? 'primary' : 'secondary'}
          icon={call.muted ? <IconMicOff size={16} /> : <IconMic size={16} />}
          aria-pressed={call.muted}
          aria-keyshortcuts="M"
          onClick={onToggleMute}
        >
          {call.muted ? 'Unmute' : 'Mute'} <kbd className="dl-kbd">M</kbd>
        </Button>
        <div className="dl-keypad-anchor">
          <Button
            ref={keypadBtn}
            icon={<IconDialer size={16} />}
            aria-expanded={keypadOpen}
            aria-haspopup="dialog"
            onClick={() => setKeypadOpen((o) => !o)}
          >
            Keypad
          </Button>
          {keypadOpen && <Keypad onDigit={onDigit} onClose={closeKeypad} />}
        </div>
        <BookMeetingButton name={unknown ? '' : contactName} email={unknown ? '' : email} businessName={unknown ? '' : businessName} variant="secondary" />
        <Button variant="danger" icon={<IconPhoneOff size={16} />} aria-keyshortcuts="H" loading={hangingUp} onClick={onHangUp}>
          Hang up <kbd className="dl-kbd dl-kbd-on-color">H</kbd>
        </Button>
      </div>
    </section>
  );
}
