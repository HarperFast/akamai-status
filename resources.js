const { hdb_analytics } = databases.system;

//constants
const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

//config
const cfg = server.config?.akamaiStatus ?? {};

const CONFIG = {
  scale: Number(cfg.loadThresholds?.scale ?? 1000),
  max: Number(cfg.loadThresholds?.max ?? cfg.loadThresholds?.scale ?? 1000),
  prefix: 'load:',
  cacheTtl: 2000,
};

//cache for load value
let loadCache = {
  value: null,
  ts: 0,
};

//helpers

//returns the most recent utilization from analytics
async function getUtilization() {
  for await (const r of hdb_analytics.search({
    conditions: [{ attribute: 'metric', value: 'utilization' }],
    sort: { attribute: 'id', descending: true },
    limit: 1,
  })) {
    return Number(r.utilization) || 0;
  }
  return null;
}

//computes load score from thread utilization
async function computeLoad() {
  const utilization = await getUtilization();
  
  //no data = max load
  if (utilization === null) return CONFIG.max;

  const scaled = Math.round(utilization * CONFIG.scale);
  return Math.min(Math.max(scaled, 0), CONFIG.max);
}

//endpoints

/**
 * GET /status
 * Returns HTTP 200 when system status is "Available", 404 otherwise.
 */
export class status extends Resource {
  allowRead() {
    return true;
  }

  async get() {
    const record = await server.operation({ operation: 'get_status', id: 'availability' });

    if (record?.status === 'Available') {
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
        loadCache.value = await computeLoad();
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
