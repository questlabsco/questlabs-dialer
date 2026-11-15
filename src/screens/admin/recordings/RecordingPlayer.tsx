/**
 * Audio player for a call's recording. Plain URLs (demo data) play directly. Stored Telnyx
 * references ('telnyx-recording:<id>') are not URLs: they are exchanged for a fresh, short-lived
 * link right before playing (never cached, so a link that expired is fetched again on retry).
 */
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../api';
import { Button, IconPlay, Spinner } from '../../../components/ui';
import { isRecordingRef, recordingErrorText } from './recordingRef';
import './recordingPlayer.css';

export interface RecordingPlayerProps {
  callId: string;
  recordingUrl: string | null;
  /** Resolve and start playing as soon as it mounts (Recordings: the row was just opened). */
  autoPlay?: boolean;
  className?: string;
}

type State = { s: 'idle' } | { s: 'loading' } | { s: 'ready'; src: string } | { s: 'error'; text: string };

export function RecordingPlayer({ callId, recordingUrl, autoPlay = false, className }: RecordingPlayerProps) {
  const isRef = isRecordingRef(recordingUrl);
  const [state, setState] = useState<State>(() =>
    !isRef && recordingUrl ? { s: 'ready', src: recordingUrl } : isRef && autoPlay ? { s: 'loading' } : { s: 'idle' },
  );
  const [play, setPlay] = useState(autoPlay);
  const seq = useRef(0);

  const resolve = async () => {
    if (!recordingUrl) return;
    const mine = ++seq.current;
    setState({ s: 'loading' });
    setPlay(true);
    try {
      const { resolveRecordingUrl } = await import('../../../telephony/telnyxAdmin');
      const src = await resolveRecordingUrl(callId, recordingUrl);
      if (mine !== seq.current) return;
      setState(src ? { s: 'ready', src } : { s: 'error', text: 'No recording for this call.' });
    } catch (e) {
      if (mine === seq.current) setState({ s: 'error', text: recordingErrorText(errorMessage(e)) });
    }
  };

  useEffect(() => {
    seq.current++;
    if (!recordingUrl) setState({ s: 'idle' });
    else if (!isRecordingRef(recordingUrl)) setState({ s: 'ready', src: recordingUrl });
    else if (autoPlay) void resolve();
    else setState({ s: 'idle' });
  }, [callId, recordingUrl]);

  if (!recordingUrl) return null;
  const cls = ['recp', className ?? ''].filter(Boolean).join(' ');

  if (state.s === 'idle') {
    return (
      <div className={cls}>
        <Button size="sm" icon={<IconPlay size={13} />} onClick={() => void resolve()}>
          Play recording
        </Button>
      </div>
    );
  }
  if (state.s === 'loading') {
    return (
      <div className={cls} aria-busy>
        <Spinner size={14} label="Loading recording" />
        <span className="muted recp-text">Loading recording</span>
      </div>
    );
  }
  if (state.s === 'error') {
    return (
      <div className={cls} role="alert">
        <span className="recp-error">{state.text}</span>
        {isRef && (
          <Button size="sm" onClick={() => void resolve()}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return (
    <audio
      className={className}
      controls
      autoPlay={play}
      preload={play ? 'auto' : 'none'}
      src={state.src}
      onError={() => setState({ s: 'error', text: isRef ? 'The recording link expired or could not be played.' : "This recording couldn't be played." })}
    />
  );
}
