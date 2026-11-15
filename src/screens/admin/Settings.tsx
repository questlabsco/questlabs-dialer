import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../api';
import { Button, Checkbox, HelpTip, Input, PageHeader, SectionHeading, Select, Spinner, Textarea, useToast } from '../../components/ui';
import type { Settings as SettingsShape } from '../../types';
import './settings/settings.css';

type NumKey = 'linesPerCaller' | 'ringSeconds' | 'retryDays' | 'defaultDailyCap' | 'rampDays' | 'rampStartCap';
type BoolKey = 'doubleRing' | 'skipVoicemail' | 'recordCalls';

interface Form {
  linesPerCaller: string;
  ringSeconds: string;
  retryDays: string;
  defaultDailyCap: string;
  rampDays: string;
  rampStartCap: string;
  doubleRing: boolean;
  skipVoicemail: boolean;
  recordCalls: boolean;
  calendlyUrl: string;
  script: string;
}

const NUM_RULES: Record<NumKey, { min: number; max: number; label: string }> = {
  linesPerCaller: { min: 1, max: 5, label: 'Lines per caller' },
  ringSeconds: { min: 10, max: 45, label: 'Ring time' },
  retryDays: { min: 1, max: 10, label: 'Retry days' },
  defaultDailyCap: { min: 1, max: 2000, label: 'Daily limit' },
  rampDays: { min: 0, max: 60, label: 'Warm-up days' },
  rampStartCap: { min: 1, max: 2000, label: 'Starting limit' },
};

function toForm(s: SettingsShape): Form {
  return {
    linesPerCaller: String(s.linesPerCaller),
    ringSeconds: String(s.ringSeconds),
    retryDays: String(s.retryDays),
    defaultDailyCap: String(s.defaultDailyCap),
    rampDays: String(s.rampDays),
    rampStartCap: String(s.rampStartCap),
    doubleRing: s.doubleRing,
    skipVoicemail: s.skipVoicemail,
    recordCalls: s.recordCalls,
    calendlyUrl: s.calendlyUrl,
    script: s.script,
  };
}

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const errors: Partial<Record<keyof Form, string>> = {};
  for (const k of Object.keys(NUM_RULES) as NumKey[]) {
    const r = NUM_RULES[k];
    const n = Number(f[k]);
    if (f[k].trim() === '' || !Number.isInteger(n) || n < r.min || n > r.max) errors[k] = `Enter a whole number from ${r.min} to ${r.max}`;
  }
  if (!errors.rampStartCap && !errors.defaultDailyCap && Number(f.rampStartCap) > Number(f.defaultDailyCap)) {
    errors.rampStartCap = "Can't be more than the daily limit";
  }
  const url = f.calendlyUrl.trim();
  if (!url) errors.calendlyUrl = 'Enter your Calendly link';
  else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !u.hostname.includes('.')) errors.calendlyUrl = 'Must be a full link starting with https://';
    } catch {
      errors.calendlyUrl = 'Must be a full link starting with https://';
    }
  }
  return errors;
}

function toSettings(f: Form): Partial<SettingsShape> {
  return {
    linesPerCaller: Number(f.linesPerCaller),
    ringSeconds: Number(f.ringSeconds),
    retryDays: Number(f.retryDays),
    defaultDailyCap: Number(f.defaultDailyCap),
    rampDays: Number(f.rampDays),
    rampStartCap: Number(f.rampStartCap),
    doubleRing: f.doubleRing,
    skipVoicemail: f.skipVoicemail,
    recordCalls: f.recordCalls,
    calendlyUrl: f.calendlyUrl.trim(),
    script: f.script,
  };
}

const SAMPLE = { contactName: 'Maria', businessName: 'Lopez Plumbing', callerName: 'Alex' } as const;

/** Script preview: line breaks kept, {placeholders} filled with sample values and highlighted. */
function renderScript(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\{(contactName|businessName|callerName)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={i++} className="script-var" title={`{${m[1]}}`}>
        {SAMPLE[m[1] as keyof typeof SAMPLE]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Admin: dialer behaviour, number warm-up, booking link and call script. */
export default function Settings() {
  const toast = useToast();
  const [saved, setSaved] = useState<SettingsShape | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    api.getSettings().then(
      (s) => {
        setSaved(s);
        setForm(toForm(s));
      },
      (e) => setLoadError(errorMessage(e)),
    );
  }, []);

  const errors = useMemo(() => (form ? validate(form) : {}), [form]);
  const dirty = useMemo(() => !!form && !!saved && JSON.stringify(form) !== JSON.stringify(toForm(saved)), [form, saved]);
  const hasErrors = Object.keys(errors).length > 0;

  if (loadError) {
    return (
      <div className="screen">
        <PageHeader title="Settings" />
        <div className="form-error">{loadError}</div>
      </div>
    );
  }
  if (!form || !saved) {
    return (
      <div className="screen">
        <PageHeader title="Settings" />
        <div className="row muted">
          <Spinner size={14} /> Loading
        </div>
      </div>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const err = (k: keyof Form) => ((submitted || (form[k] !== toForm(saved)[k])) && errors[k] ? errors[k] : undefined);

  const save = async () => {
    setSubmitted(true);
    if (hasErrors) {
      toast.error('Fix the highlighted fields first.');
      return;
    }
    setSaving(true);
    try {
      const s = await api.saveSettings(toSettings(form));
      setSaved(s);
      setForm(toForm(s));
      setSubmitted(false);
      toast.success('Settings saved. Applies from each caller\'s next call.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const withTip = (label: string, tip: string) => (
    <>
      {label}
      <HelpTip text={tip} />
    </>
  );
  const numberField = (k: NumKey, label: string, tip: string, unit?: string) => (
    <Input
      label={withTip(label, tip)}
      type="number"
      inputMode="numeric"
      min={NUM_RULES[k].min}
      max={NUM_RULES[k].max}
      value={form[k]}
      onChange={(e) => set(k, e.target.value)}
      error={err(k)}
      hint={unit}
      fieldClassName="set-num"
    />
  );
  const toggle = (k: BoolKey, label: string, tip: string) => <Checkbox label={withTip(label, tip)} checked={form[k]} onChange={(v) => set(k, v)} />;

  const rampExample = (() => {
    const cap = Number(form.defaultDailyCap);
    const start = Number(form.rampStartCap);
    const days = Number(form.rampDays);
    if (errors.defaultDailyCap || errors.rampStartCap || errors.rampDays) return null;
    if (days === 0) return `New numbers: ${cap} calls a day from day 1.`;
    return `New numbers: ${Math.min(start, cap)} calls on day 1, ${cap} a day after ${days} days.`;
  })();

  return (
    <div className="screen settings-screen">
      <PageHeader
        title="Settings"
        subtitle={dirty ? 'Unsaved changes' : 'Dialer settings for the whole team'}
        actions={
          <>
            <Button
              disabled={!dirty || saving}
              onClick={() => {
                setForm(toForm(saved));
                setSubmitted(false);
              }}
            >
              Undo changes
            </Button>
            <Button type="submit" form="settings-form" variant="primary" disabled={!dirty} loading={saving}>
              Save settings
            </Button>
          </>
        }
      />

      <form
        id="settings-form"
        className="settings-form card"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <section className="set-section" aria-labelledby="set-dialing">
          <SectionHeading id="set-dialing">Dialing</SectionHeading>
          <div className="set-grid">
            <Select
              label={withTip('Lines per caller', 'How many leads ring at the same time for each caller. The first to pick up is connected; the others are hung up and tried again later.')}
              value={form.linesPerCaller}
              onChange={(e) => set('linesPerCaller', e.target.value)}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 1 ? '1 line' : `${n} lines` }))}
              error={err('linesPerCaller')}
              fieldClassName="set-num"
            />
            {numberField('ringSeconds', 'Ring time', 'How long a phone rings before it counts as no answer. Most voicemail picks up after 20 to 25 seconds.', '10-45 seconds')}
            {numberField('retryDays', 'Retry days', 'How many different days a lead is tried before giving up on it.', '1-10 days')}
          </div>
          <div className="set-toggles">
            {toggle('doubleRing', 'Ring twice', 'If nobody picks up, call the same number again right away. People often answer the second call.')}
            {toggle('skipVoicemail', 'Skip voicemails', 'Hang up automatically when an answering machine picks up, so callers only talk to people.')}
            {toggle('recordCalls', 'Record calls', 'Save a recording of every answered call to listen to under Recordings. Check your local rules on telling people calls are recorded.')}
          </div>
        </section>

        <section className="set-section" aria-labelledby="set-warmup">
          <SectionHeading id="set-warmup" actions={rampExample ? <span className="set-example">{rampExample}</span> : undefined}>
            Number warm-up
            <HelpTip text="Ramping up new numbers slowly protects them from being flagged as spam." />
          </SectionHeading>
          <div className="set-grid">
            {numberField('defaultDailyCap', 'Daily limit for new numbers', 'Most calls a number makes per day once warmed up. You can change it per number on the Numbers screen.', 'calls per day')}
            {numberField('rampDays', 'Warm-up days', 'How many days a new number takes to reach its daily limit. 0 means no warm-up.', '0-60 days')}
            {numberField('rampStartCap', 'Starting limit', 'Calls allowed on the day a number is added.', 'calls on day 1')}
          </div>
        </section>

        <section className="set-section" aria-labelledby="set-booking">
          <SectionHeading id="set-booking">Booking</SectionHeading>
          <div className="set-grid">
            <Input
              label={withTip('Calendly link', "Opens when a caller marks a call as booked, with the lead's name and email filled in.")}
              type="url"
              value={form.calendlyUrl}
              onChange={(e) => set('calendlyUrl', e.target.value)}
              placeholder="https://calendly.com/your-name/intro-call"
              error={err('calendlyUrl')}
              fieldClassName="set-wide"
            />
          </div>
        </section>

        <section className="set-section" aria-labelledby="set-script">
          <SectionHeading id="set-script">Call script</SectionHeading>
          <div className="script-layout">
            <Textarea
              label="Script"
              rows={16}
              value={form.script}
              onChange={(e) => set('script', e.target.value)}
              hint="Placeholders: {contactName}, {businessName}, {callerName}"
              className="script-input"
              fieldClassName="script-edit"
            />
            <div className="script-preview-wrap">
              <div className="field-label">
                Preview ({SAMPLE.contactName}, {SAMPLE.businessName}, caller {SAMPLE.callerName})
              </div>
              <div className="script-preview" aria-live="polite">
                {form.script.trim() ? renderScript(form.script) : <span className="muted">Empty script</span>}
              </div>
            </div>
          </div>
        </section>
      </form>
    </div>
  );
}
