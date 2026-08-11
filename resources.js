const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

const cfg = server.config?.akamaiStatus ?? {};

const CONFIG = {
	scale: Number(cfg.loadThresholds?.scale ?? 1000),
	max: Number(cfg.loadThresholds?.max ?? cfg.loadThresholds?.scale ?? 1000),
	prefix: 'load:',
	cacheTtl: 2000,
	// The window must span at least one analytics aggregation period (60s by default) or a
	// node that just aggregated will look like it has no data at all.
	utilizationWindow: 120000,
};

let cachedLoad = null;
let cachedAt = 0;
let pendingLoad = null;

// Reporting max load takes a node out of GTM rotation, so a silent failure here is an outage
// with no signal. GTM polls continuously, so log the transition rather than every poll.
let degradedReason = null;

function reportMaxLoad(reason) {
	if (reason !== degradedReason) {
		degradedReason = reason;
		logger.warn(`akamai-status: reporting max load (${CONFIG.max}) for GTM — ${reason}`);
	}
	return CONFIG.max;
}

function clearDegraded() {
	if (degradedReason) {
		logger.warn(`akamai-status: load feedback recovered, resuming measured load`);
		degradedReason = null;
	}
}

async function getUtilization() {
	// `server.hostname` is the node identity analytics rows are attributed to; `replication.hostname`
	// is only one of the fallbacks it resolves through and can be unset.
	const nodeName = server.hostname;

	const results = await server.operation({
		operation: 'get_analytics',
		metric: 'utilization',
		start_time: Date.now() - CONFIG.utilizationWindow,
	});

	let latest = null;
	for await (const record of results) {
		if (record.node === nodeName && (!latest || record.id > latest.id)) {
			latest = record;
		}
	}

	return latest ? Number(latest.utilization) || 0 : null;
}

async function computeLoad() {
	let utilization;
	try {
		utilization = await getUtilization();
	} catch (error) {
		logger.warn('akamai-status: get_analytics failed', error);
		return reportMaxLoad('utilization query failed');
	}

	if (utilization === null) {
		return reportMaxLoad('no utilization analytics for this node (expected briefly after a restart)');
	}

	clearDegraded();
	const scaled = Math.round(utilization * CONFIG.scale);
	return Math.min(Math.max(scaled, 0), CONFIG.max);
}

function getLoad() {
	if (cachedLoad !== null && Date.now() - cachedAt <= CONFIG.cacheTtl) return cachedLoad;
	// Share one in-flight computation so a burst of polls costs a single analytics scan.
	pendingLoad ??= computeLoad().then(
		(value) => {
			cachedLoad = value;
			cachedAt = Date.now();
			pendingLoad = null;
			return value;
		},
		(error) => {
			pendingLoad = null;
			logger.warn('akamai-status: load computation failed', error);
			return CONFIG.max;
		}
	);
	return pendingLoad;
}

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

	async post() {
		await server.operation({ operation: 'set_status', id: 'availability', status: 'Available' });
	}

	async delete() {
		await server.operation({ operation: 'set_status', id: 'availability', status: 'Unavailable' });
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
		return `${CONFIG.prefix}${await getLoad()}`;
	}
}
