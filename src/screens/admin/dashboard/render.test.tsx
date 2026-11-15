import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoApi } from '../../../api/demoApi';
import { HeadlineTiles } from './HeadlineTiles';
import { TrendCard } from './TrendCharts';
import { CallersCard, ListsCard, NumbersCard, OutcomesCard } from './Breakdowns';
import { numberHealth, rangeFromPreset, type RangePreset } from './chartMath';

const NOW = new Date(2026, 10, 11, 14, 0, 0).getTime();

async function metricsFor(preset: RangePreset, empty = false) {
  const api = new DemoApi({ storage: null, now: () => NOW, simulatePresence: false, empty });
  await api.signInDemo('admin');
  return api.getMetrics(rangeFromPreset(preset, NOW)!);
}

describe('dashboard sections render with demo data', () => {
  for (const preset of ['today', '7d', '30d'] as const) {
    it(`renders every section for ${preset}`, async () => {
      const m = await metricsFor(preset);
      const html = renderToStaticMarkup(
        <>
          <HeadlineTiles totals={m.totals} previous={m.previousTotals} comparison="vs prev." />
          <TrendCard days={m.byDay} />
          <CallersCard rows={m.byCaller} />
          <OutcomesCard outcomes={m.outcomes} />
          <NumbersCard rows={m.byNumber} health={numberHealth(m.byNumber)} />
          <ListsCard rows={m.byList} />
        </>,
      );
      expect(html).toContain('Dropped pickups');
      expect(html).not.toContain('NaN');
      expect(html).not.toContain('Infinity');
      if (preset === 'today') expect(html).toContain('A single day is selected');
      else expect(html).toContain('Dials per day');
    });
  }

  it('renders an empty data set without errors', async () => {
    const m = await metricsFor('7d', true);
    const html = renderToStaticMarkup(
      <>
        <HeadlineTiles totals={m.totals} previous={m.previousTotals} comparison="vs prev." />
        <TrendCard days={m.byDay} />
        <OutcomesCard outcomes={m.outcomes} />
        <NumbersCard rows={m.byNumber} health={numberHealth(m.byNumber)} />
      </>,
    );
    expect(html).toContain('None in either period');
    expect(html).not.toContain('NaN');
  });
});
