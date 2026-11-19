import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '../../api/supabaseClient';
import { Button, Card } from '../../components/ui';

// Telnyx can play PCM WAV directly. Resample locally after capture so recording never blocks a call.
async function wav(blob: Blob): Promise<Blob> {
  const context = new OfflineAudioContext(1, 1, 16000);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const samples = decoded.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, decoded.sampleRate, true);
  view.setUint32(28, decoded.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

function Message({ callerId, kind }: { callerId: string; kind: 'screening' | 'voicemail' }) {
  const path = callerId + '/' + kind + '.wav';
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(false);
  const bucket = () => getSupabase().storage.from('caller-messages');
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void bucket()
      .list(callerId, { search: kind + '.wav' })
      .then(async ({ data, error }) => {
        if (error) throw error;
        if (!data?.length) return;
        const signed = await bucket().createSignedUrl(path, 3600);
        if (signed.error) throw signed.error;
        if (alive) setUrl(signed.data.signedUrl);
      })
      .catch(() => {
        if (alive) setNotice('Could not load saved message.');
      });
    return () => {
      alive = false;
      mounted.current = false;
      if (recorder.current?.state === 'recording') recorder.current.stop();
    };
  }, [path, callerId, kind]);
  useEffect(() => {
    if (!draft) return;
    const local = URL.createObjectURL(draft);
    setUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [draft]);
  async function record() {
    setBusy(true);
    setNotice('');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const tracks = stream.getTracks();
      const mic = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.current = mic;
      mic.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const limit = window.setTimeout(() => {
        if (mic.state === 'recording') mic.stop();
      }, 45000);
      mic.onstop = async () => {
        clearTimeout(limit);
        tracks.forEach((t) => t.stop());
        if (!mounted.current) return;
        setRecording(false);
        setBusy(true);
        try {
          setDraft(await wav(new Blob(chunks, { type: mic.mimeType })));
          setNotice('Preview and save your message.');
        } catch {
          setNotice('Could not read the recording. Record again.');
        } finally {
          setBusy(false);
        }
      };
      mic.start();
      setRecording(true);
    } catch {
      stream?.getTracks().forEach((t) => t.stop());
      setNotice('Could not record. Check microphone access.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const { error } = await bucket().upload(path, draft, { upsert: true, contentType: 'audio/wav', cacheControl: '0' });
      if (error) throw error;
      setNotice('Saved for future calls.');
    } catch {
      setNotice('Upload failed. Your preview is available to retry.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="stack">
      <strong>{kind === 'screening' ? 'iPhone screening introduction' : 'Voicemail message'}</strong>
      <div className="row">
        <Button disabled={busy} onClick={() => (recording ? recorder.current?.stop() : void record())}>
          {recording ? 'Stop recording' : 'Record'}
        </Button>
        {draft && (
          <Button disabled={busy || recording} onClick={() => void save()}>
            Save message
          </Button>
        )}
      </div>
      {url && <audio controls src={url} aria-label={kind + ' preview'} />}
      <small role="status">{notice}</small>
    </section>
  );
}
export default function CallerMessages({ callerId }: { callerId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="My recorded messages">
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Record or preview messages</summary>
        <p>Record up to 45 seconds. Your voicemail plays after the greeting on the final attempt.</p>
        {open && (
          <>
            <Message callerId={callerId} kind="screening" />
            <Message callerId={callerId} kind="voicemail" />
          </>
        )}
      </details>
    </Card>
  );
}
