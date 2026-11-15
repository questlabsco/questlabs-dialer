import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, IconAlert, IconMic, Select } from '../../components/ui';

type MicStatus = 'off' | 'starting' | 'live' | 'error';

function micErrorMessage(e: unknown): string {
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow microphone access for Quest Labs Dialer (on Mac: System Settings > Privacy & Security > Microphone; on Windows: Settings > Privacy > Microphone), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Plug in your headset, then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or not responding. Close other apps that use it (Zoom, Teams...) or replug the headset, then try again.';
    default:
      return 'The microphone could not be started. Replug your headset and try again.';
  }
}

/**
 * Headset check for the idle screen: lists input devices and shows a live input level.
 * The stream is stopped when the component unmounts (e.g. as soon as dialing starts).
 */
export function MicCheck() {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const [status, setStatus] = useState<MicStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [heard, setHeard] = useState(false);
  const meterRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audioinput'));
    } catch {
      setDevices([]);
    }
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current) void ctxRef.current.close().catch(() => undefined);
    ctxRef.current = null;
    if (meterRef.current) meterRef.current.style.width = '0%';
  }, []);

  const start = useCallback(
    async (id: string) => {
      stop();
      setError(null);
      setHeard(false);
      if (!supported) {
        setStatus('error');
        setError('Microphone testing is not available here. Your headset will still be used for calls.');
        return;
      }
      setStatus('starting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: id ? { deviceId: { exact: id } } : true,
        });
        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        const actualId = track?.getSettings?.().deviceId;
        if (actualId && !id) setDeviceId(actualId);
        void refreshDevices(); // labels become available after permission

        const AudioCtx: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) {
          setStatus('live');
          return;
        }
        const ctx = new AudioCtx();
        ctxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let heardOnce = false;
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          const level = Math.min(1, rms * 4);
          if (meterRef.current) meterRef.current.style.width = `${Math.round(level * 100)}%`;
          if (!heardOnce && level > 0.12) {
            heardOnce = true;
            setHeard(true);
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
        setStatus('live');
      } catch (e) {
        stop();
        setStatus('error');
        setError(micErrorMessage(e));
      }
    },
    [stop, supported, refreshDevices],
  );

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return () => stop();
    const onChange = () => void refreshDevices();
    md.addEventListener('devicechange', onChange);
    return () => {
      md.removeEventListener('devicechange', onChange);
      stop();
    };
  }, [refreshDevices, stop]);

  const options = devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }));

  return (
    <Card
      title="Headset check"
    >
      <div className="stack">
        {options.length > 0 && (
          <Select
            label="Microphone"
            value={deviceId}
            options={options}
            placeholder="System default"
            onChange={(e) => {
              setDeviceId(e.target.value);
              if (status === 'live' || status === 'starting') void start(e.target.value);
            }}
          />
        )}
        <div className="dl-meter" aria-hidden="true">
          <div className="dl-meter-fill" ref={meterRef} />
        </div>
        <div className="dl-mic-status" role="status">
          {status === 'off' && <span className="muted">Not recorded</span>}
          {status === 'starting' && <span className="muted">Starting microphone</span>}
          {status === 'live' && (heard ? <span className="dl-good-text">Microphone working</span> : <span className="muted">Speak; the bar should move</span>)}
          {status === 'error' && error && (
            <span className="dl-error-text">
              <IconAlert size={14} /> {error}
            </span>
          )}
        </div>
        <div className="row">
          {status === 'live' || status === 'starting' ? (
            <Button
              size="sm"
              onClick={() => {
                stop();
                setStatus('off');
              }}
            >
              Stop test
            </Button>
          ) : (
            <Button size="sm" icon={<IconMic size={14} />} onClick={() => void start(deviceId)}>
              {status === 'error' ? 'Try again' : 'Test microphone'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
