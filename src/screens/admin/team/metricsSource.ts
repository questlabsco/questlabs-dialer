/** Shared getMetrics cache for the Team screen (list, previous period, per-day trend). */
import { api } from '../../../api';
import { MetricsCache } from './teamPerf';

export const metricsCache = new MetricsCache((range) => api.getMetrics(range));
