import { describe, expect, it } from 'vitest';
import { createScriptStore, insertToken, saveIntent, scriptVarsFor, SCRIPT_PLACEHOLDERS, type ScriptSource } from './ScriptPanel';
import { renderScript } from './dialerLogic';
import type { MyScript } from '../../api/Api';
import type { Lead } from '../../types';

const lead = { id: 'l1', contactName: 'Dana', businessName: 'Acme' } as Lead;

describe('script helpers', () => {
  it('fills placeholders from the lead, or shows bracketed placeholders without one', () => {
    const s = 'Hi {contactName}, {callerName} here about {businessName}.';
    expect(renderScript(s, scriptVarsFor(lead, 'Sam'))).toBe('Hi Dana, Sam here about Acme.');
    expect(renderScript(s, scriptVarsFor(null, 'Sam'))).toBe('Hi [contact name], Sam here about [business name].');
    expect(renderScript(s, scriptVarsFor({ ...lead, id: 'unknown:+1555' }, 'Sam'))).toBe('Hi [contact name], Sam here about [business name].');
    expect(renderScript(s, scriptVarsFor({ ...lead, contactName: '' }, 'Sam'))).toBe('Hi there, Sam here about Acme.');
  });

  it('lists exactly the placeholders renderScript understands', () => {
    const all = SCRIPT_PLACEHOLDERS.map((p) => p.token).join(' ');
    expect(renderScript(all, { contactName: 'a', businessName: 'b', callerName: 'c' })).toBe('a b c');
  });

  it('inserts a token over the selection', () => {
    expect(insertToken('Hello world', 6, 11, '{contactName}')).toEqual({ text: 'Hello {contactName}', caret: 19 });
    expect(insertToken('abc', 99, 99, 'X')).toEqual({ text: 'abcX', caret: 4 });
    expect(insertToken('abc', 2, 1, 'X')).toEqual({ text: 'abXc', caret: 3 });
  });

  it('decides what Save does', () => {
    const cur: MyScript = { script: 'Team', isPersonal: false, teamScript: 'Team' };
    expect(saveIntent('  ', cur)).toEqual({ kind: 'empty' });
    expect(saveIntent('Team', cur)).toEqual({ kind: 'unchanged' });
    expect(saveIntent('Mine', cur)).toEqual({ kind: 'save', script: 'Mine' });
  });
});

function fakeSource(team = 'Team') {
  let mine: string | null = null;
  let calls = 0;
  let failNext = false;
  const src: ScriptSource & { calls: () => number; failNextSave: () => void } = {
    async getMyScript() {
      calls++;
      return mine ? { script: mine, isPersonal: true, teamScript: team } : { script: team, isPersonal: false, teamScript: team };
    },
    async saveMyScript(s) {
      if (failNext) {
        failNext = false;
        throw new Error('Network down');
      }
      mine = s && s.trim() ? s : null;
    },
    calls: () => calls,
    failNextSave: () => {
      failNext = true;
    },
  };
  return src;
}

describe('script store', () => {
  it('shares one load between panels and caches it', async () => {
    const src = fakeSource();
    let t = 0;
    const store = createScriptStore(src, () => t);
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(src.calls()).toBe(1);
    expect(store.getSnapshot().value).toEqual({ script: 'Team', isPersonal: false, teamScript: 'Team' });
    t = 31_000;
    await store.load();
    expect(src.calls()).toBe(2);
  });

  it('save updates every subscriber, reset goes back to the team script', async () => {
    const store = createScriptStore(fakeSource());
    await store.load();
    let notified = 0;
    store.subscribe(() => notified++);
    store.setDraft('Mine');
    await store.save('Mine');
    expect(store.getSnapshot()).toMatchObject({ value: { script: 'Mine', isPersonal: true }, draft: null });
    await store.save(null);
    expect(store.getSnapshot().value).toEqual({ script: 'Team', isPersonal: false, teamScript: 'Team' });
    expect(notified).toBeGreaterThanOrEqual(3);
  });

  it('keeps the draft when a save fails', async () => {
    const src = fakeSource();
    const store = createScriptStore(src);
    await store.load();
    store.setDraft('Unsaved words');
    src.failNextSave();
    await expect(store.save('Unsaved words')).rejects.toThrow('Network down');
    expect(store.getSnapshot()).toMatchObject({ draft: 'Unsaved words', value: { isPersonal: false } });
  });

  it('an older in-flight load cannot overwrite a newer save', async () => {
    let resolveLoad: (v: MyScript) => void = () => undefined;
    const src: ScriptSource = {
      getMyScript: () => new Promise<MyScript>((r) => (resolveLoad = r)),
      saveMyScript: async () => undefined,
    };
    const store = createScriptStore(src);
    // Seed a value so save() knows the team script.
    const first = store.load({ force: true });
    resolveLoad({ script: 'Team', isPersonal: false, teamScript: 'Team' });
    await first;
    const stale = store.load({ force: true });
    await store.save('Newer');
    resolveLoad({ script: 'Team', isPersonal: false, teamScript: 'Team' });
    await stale;
    expect(store.getSnapshot().value?.script).toBe('Newer');
  });

  it('reports load errors and clears on demand', async () => {
    const store = createScriptStore({ getMyScript: async () => Promise.reject(new Error('Please sign in.')), saveMyScript: async () => undefined });
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ value: null, loadError: 'Please sign in.', loading: false });
    store.clear();
    expect(store.getSnapshot()).toEqual({ value: null, loading: false, loadError: null, draft: null, editor: null });
  });

  it('only one panel shows the editor; the draft moves to the next panel when it unmounts', async () => {
    const store = createScriptStore(fakeSource());
    await store.load();
    store.setDraft('Team', 'idle');
    store.claim('other');
    expect(store.getSnapshot().editor).toBe('idle');
    store.setDraft('Team edited');
    expect(store.getSnapshot()).toMatchObject({ draft: 'Team edited', editor: 'idle' });
    store.release('idle'); // idle panel unmounted mid-edit
    expect(store.getSnapshot()).toMatchObject({ draft: 'Team edited', editor: null });
    store.claim('connected');
    expect(store.getSnapshot()).toMatchObject({ draft: 'Team edited', editor: 'connected' });
    store.claim('third', true);
    expect(store.getSnapshot().editor).toBe('third');
    store.setDraft(null);
    expect(store.getSnapshot()).toMatchObject({ draft: null, editor: null });
  });
});
