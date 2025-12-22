const { hdb_status, hdb_analytics } = databases.system;

//constants
const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

//config
const cfg = server.config?.akamaiStatus ?? {};

const CONFIG = {
  metrics: new Set(cfg.loadFeedbackMetrics ?? ['threads']),
  scale: Number(cfg.loadThresholds?.scale ?? 1000),
  max: Number(cfg.loadThresholds?.max ?? cfg.loadThresholds?.scale ?? 1000),
  prefix: 'load:',
  cacheTtl: 2000,
};

const WEIGHTS = {
  threads: 0.7,
  cpu: 0.2,
  memory: 0.1,
};

//cache for load value
let loadCache = {
  value: null,
  ts: 0,
};

//helpers

//returns the most recent analytics record for a given metric
async function getLatestMetric(metricName) {
  for await (const r of hdb_analytics.search({
    conditions: [{ attribute: 'metric', value: metricName }],
    sort: { attribute: 'id', descending: true },
    limit: 1,
  })) {
    return r;
  }
  return null;
}

//computes a weighted load score from analytics metrics
async function computeLoadFromAnalytics() {
  const utilRow = CONFIG.metrics.has('threads') ? await getLatestMetric('utilization') : null;
  const cpuRow = CONFIG.metrics.has('cpu') ? await getLatestMetric('resource-usage') : null;
  const memRow = CONFIG.metrics.has('memory') ? await getLatestMetric('main-thread-utilization') : null;

  let score = 0;
  let weight = 0;

  if (CONFIG.metrics.has('threads') && utilRow) {
    score += WEIGHTS.threads * (Number(utilRow.utilization) || 0);
    weight += WEIGHTS.threads;
  }

  if (CONFIG.metrics.has('cpu') && cpuRow) {
    score += WEIGHTS.cpu * (Number(cpuRow.cpuUtilization) || 0);
    weight += WEIGHTS.cpu;
  }

  if (CONFIG.metrics.has('memory') && memRow) {
    const used = Number(memRow.heapUsed);
    const total = Number(memRow.heapTotal);
    if (used > 0 && total > 0) {
      score += WEIGHTS.memory * (used / total);
      weight += WEIGHTS.memory;
    }
  }

  //no metrics enabled = max load 
  if (weight === 0) return CONFIG.max;

  const normalized = score / weight;
  const scaled = Math.round(normalized * CONFIG.scale);

  return Math.min(Math.max(scaled, 0), CONFIG.max);
}

//endpoints

/**
 * GET /status
 * Returns HTTP 200 when system status is "Ready", 404 otherwise.
 */
export class status extends Resource {
  allowRead() {
    return true;
  }

  async get() {
    const record = await hdb_status.get('primary');

    if (record?.status === 'Ready') {
      return DEFAULT_200_MSG;
    }

    const err = new Error(DEFAULT_404_MSG);
    err.statusCode = 404;
    throw err;
  }
}

/**
 * GET /current_load_for_gtm
 * Returns server load for Akamai in format "load:N".
 */
export class current_load_for_gtm extends Resource {
  allowRead() {
    return true;
  }

  async get() {
    const now = Date.now();

    if (loadCache.value === null || now - loadCache.ts > CONFIG.cacheTtl) {
      try {
        loadCache.value = await computeLoadFromAnalytics();
        loadCache.ts = now;
      } catch {
        //return max load on error
        loadCache.value = CONFIG.max;
        loadCache.ts = now;
      }
    }

    return `${CONFIG.prefix}${loadCache.value}`;
  }
}
