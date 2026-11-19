import { useState } from 'react';
import { Card, Button } from '../../components/ui';
import { getSupabase } from '../../api/supabaseClient';
import { clearCallDraft, type CallDraft } from './callerHooks';

export function RecoveredNotes({ callerId }: { callerId: string }) {
  const [entries, setEntries] = useState(() => {
    const prefix = 'call-draft:' + callerId + ':';
    const notes: { id: string; text: string }[] = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        const draft = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<CallDraft>;
        if (draft.notes?.trim()) notes.push({ id: key.slice(prefix.length), text: draft.notes });
      }
    } catch {
      /* locally stored drafts are optional */
    }
    return notes;
  });
  const [notice, setNotice] = useState('');
  if (!entries.length) return null;
  async function save(id: string, notes: string) {
    const { data, error } = await getSupabase()
      .from('calls')
      .update({ notes })
      .eq('id', id)
      .eq('caller_id', callerId)
      .is('disposition', null)
      .select('id');
    if (error || !data?.length) {
      setNotice('Could not save to this call. Your notes are still available here.');
      return;
    }
    clearCallDraft(id, callerId);
    setEntries((rows) => rows.filter((r) => r.id !== id));
  }
  return (
    <Card title="Recovered call notes">
      {entries.map((entry) => (
        <div className="stack" key={entry.id}>
          <p>{entry.text}</p>
          <Button onClick={() => void save(entry.id, entry.text)}>Save to original call</Button>
        </div>
      ))}
      <small role="status">{notice}</small>
    </Card>
  );
}
