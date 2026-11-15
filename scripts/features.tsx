// Dev-only preview of ScriptPanel and BookMeetingButton (see features.html). Signs in a demo caller.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/theme.css';
import { api } from '../src/api';
import { ApiError } from '../src/api/Api';
import type { Lead } from '../src/types';
import ScriptPanel from '../src/screens/caller/ScriptPanel';
import { BookMeetingButton, onCalendlyMessage, onMeetingBooked } from '../src/screens/caller/Booking';

const q = new URLSearchParams(location.search);

const lead = {
  id: 'preview-lead',
  businessName: 'Gutierrez Family Dental',
  contactName: 'Marisol Gutierrez',
  email: 'marisol@example.com',
} as Lead;

declare global {
  interface Window {
    __cal: { event: string }[];
    __booked: number;
  }
}
window.__cal = [];
window.__booked = 0;
onCalendlyMessage((m) => window.__cal.push({ event: m.event }));
onMeetingBooked(() => window.__booked++);

async function boot() {
  if (q.get('calendly') === 'unset') {
    await api.signInDemo('admin');
    await api.saveSettings({ calendlyUrl: 'https://calendly.com/your-link' });
  }
  const me = await api.signInDemo('caller');
  if (q.get('failsave') === '1') {
    (api as { saveMyScript: (s: string | null) => Promise<void> }).saveMyScript = async () => {
      throw new ApiError('invalid', 'Network is unreachable (simulated).');
    };
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, background: 'var(--canvas)', minHeight: '100vh', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div id="panel-lead">
            <ScriptPanel lead={lead} callerName={me.fullName} />
          </div>
          <div id="panel-idle">
            <ScriptPanel lead={null} callerName={me.fullName} compact />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <div id="book-primary">
            <BookMeetingButton name={lead.contactName} email={lead.email} businessName={lead.businessName} />
          </div>
          <div id="book-secondary">
            <BookMeetingButton name="No Email Person" email="" businessName="Walk-in Co" variant="secondary" size="sm" />
          </div>
          <textarea id="hotkey-probe" placeholder="hotkey probe" />
        </div>
      </div>
    </StrictMode>,
  );
  if (q.get('open') === '1') {
    setTimeout(() => (document.querySelector('#book-primary button') as HTMLButtonElement | null)?.click(), 600);
  }
}

void boot();
