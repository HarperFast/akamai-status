const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

const cfg = server.config?.akamaiStatus ?? {};

const CONFIG = {
	scale: Number(cfg.loadThresholds?.scale ?? 1000),
	max: Number(cfg.loadThresholds?.max ?? cfg.loadThresholds?.scale ?? 1000),
	prefix: 'load:',
	cacheTtl: 2000,
	// Two aggregation periods, so a node that has just aggregated still has a row in range.
	// Derived rather than hard-coded: an operator raising analytics.aggregatePeriod past a fixed
	// window would otherwise push every node to max load permanently.
	utilizationWindow: Math.max(2000 * Number(server.config?.analytics?.aggregatePeriod ?? 60), 120000),
};

let cachedLoad = null;
let cachedAt = 0;
let pendingLoad = null;

// Reporting max load takes a node out of GTM rotation, so log the transition — GTM polls
// continuously, and a per-poll line would bury the one an operator needs.
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
	// The identity analytics rows are attributed to; `replication.hostname` is only one of the
	// fallbacks it resolves through and can be unset.
	const nodeName = server.hostname;

	// Both bounds are set so core can pin the primary-key range; a one-sided range leaves the
	// planner free to drive off `metric equals` and decode the metric's whole retained history.
	const now = Date.now();
	const results = await server.operation({
		operation: 'get_analytics',
		metric: 'utilization',
		start_time: now - CONFIG.utilizationWindow,
		end_time: now,
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
		return reportMaxLoad(`utilization query failed: ${error?.message ?? error}`);
	}

	if (utilization === null) {
		return reportMaxLoad(
			'no utilization analytics for this node — expected for one aggregation period after a restart, ' +
				'otherwise check that analytics are being written and that node.hostname matches this node'
		);
	}

	clearDegraded();
	const scaled = Math.round(utilization * CONFIG.scale);
	return Math.min(Math.max(scaled, 0), CONFIG.max);
}

function getLoad() {
	if (cachedLoad !== null && Date.now() - cachedAt <= CONFIG.cacheTtl) return cachedLoad;
	pendingLoad ??= computeLoad().then(
		(value) => {
			cachedLoad = value;
			cachedAt = Date.now();
			pendingLoad = null;
			return value;
		},
		(error) => {
			pendingLoad = null;
			return reportMaxLoad(`load computation failed: ${error?.message ?? error}`);
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
