const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

const cfg = server.config?.akamaiStatus ?? {};

// A non-numeric configured value would otherwise produce NaN bounds, which match no rows and pin
// the node at max load.
const aggregatePeriodSeconds = Number(server.config?.analytics?.aggregatePeriod) || 60;

const CONFIG = {
	scale: Number(cfg.loadThresholds?.scale ?? 1000),
	max: Number(cfg.loadThresholds?.max ?? cfg.loadThresholds?.scale ?? 1000),
	// The request rate that maps to full scale. GTM compares reported loads across datacenters, so
	// this anchors what fully loaded means for an instance; tune it per instance size. Guarded like
	// aggregatePeriod above: a non-numeric or non-positive value would make every load NaN.
	targetRps: Math.max(Number(cfg.loadThresholds?.targetRps) || 1000, 1),
	prefix: 'load:',
	// Half an aggregation period: the underlying metric only moves once per period, so a shorter
	// TTL just re-runs the scan — and `node` is resolved per row by an awaited table get in core,
	// so each scan is proportional to the cluster's row count, not free.
	cacheTtl: Math.max(500 * aggregatePeriodSeconds, 2000),
	// Two aggregation periods, so a node that has just aggregated still has a row in range.
	// Derived rather than hard-coded: an operator raising analytics.aggregatePeriod past a fixed
	// window would otherwise push every node to max load permanently.
	analyticsWindow: Math.max(2000 * aggregatePeriodSeconds, 120000),
};

// One aggregation cycle stores its rows in a tight loop while successive cycles are at least half
// an aggregation period apart, so this margin groups the newest cycle's rows without ever reaching
// back into the previous cycle.
const CYCLE_MARGIN_MS = 5000;

let cachedLoad = null;
let cachedAt = 0;
let pendingLoad = null;

// Reporting max load takes a node out of GTM rotation, so log the transition — GTM polls
// continuously, and a per-poll line would bury the one an operator needs.
let degradedReason = null;

// Keyed on a stable code, not the logged text: interpolating an error message would make every
// refresh of one wedged-analytics episode look like a new episode and warn again.
function reportMaxLoad(code, detail) {
	if (code !== degradedReason) {
		degradedReason = code;
		logger.warn(`akamai-status: reporting max load (${CONFIG.max}) for GTM — ${detail}`);
	}
	return CONFIG.max;
}

function clearDegraded() {
	if (degradedReason) {
		logger.warn(`akamai-status: load feedback recovered, resuming measured load`);
		degradedReason = null;
	}
}

function queryMetric(metric) {
	// Both bounds are set so core can pin the primary-key range; a one-sided range leaves the
	// planner free to drive off `metric equals` and decode the metric's whole retained history.
	const now = Date.now();
	return server.operation({
		operation: 'get_analytics',
		metric,
		start_time: now - CONFIG.analyticsWindow,
		end_time: now,
	});
}

// Returns this node's HTTP request rate in requests per second from the newest aggregation cycle,
// 0 for a healthy node that saw no requests, or null when analytics are not being written at all.
async function getRequestRate() {
	// The identity analytics rows are attributed to. `replication.hostname` is only one of the
	// fallbacks core resolves it through, and can be unset.
	const nodeName = server.hostname;

	// Every HTTP request records a `success` sample, aggregated per path and method with `count`
	// summed across threads, so one cycle's request total is the sum of `count` over its rows.
	const rows = [];
	let newest = null;
	const results = await queryMetric('success');
	for await (const record of results) {
		if (record.node !== nodeName) continue;
		rows.push(record);
		if (!newest || record.id > newest.id) newest = record;
	}

	if (!newest) {
		// No request rows can mean an idle node or a dead analytics pipeline, and only the latter
		// should shed. Core writes a resource-usage row every aggregation cycle regardless of
		// traffic, so its presence distinguishes the two.
		const health = await queryMetric('resource-usage');
		for await (const record of health) {
			if (record.node === nodeName) return 0;
		}
		return null;
	}

	let requestCount = 0;
	for (const record of rows) {
		if (newest.id - record.id <= CYCLE_MARGIN_MS) requestCount += Number(record.count) || 0;
	}
	const periodMs = Number(newest.period) || aggregatePeriodSeconds * 1000;
	return requestCount / (periodMs / 1000);
}

async function computeLoad() {
	let rate;
	try {
		rate = await getRequestRate();
	} catch (error) {
		return reportMaxLoad('analytics-query-failed', `request rate query failed: ${error?.message ?? error}`);
	}

	if (rate === null) {
		return reportMaxLoad(
			'analytics-missing',
			'no analytics rows for this node, expected for one aggregation period after a restart; ' +
				'otherwise check that analytics are being written and that node.hostname matches this node'
		);
	}

	clearDegraded();
	const scaled = Math.round((rate / CONFIG.targetRps) * CONFIG.scale);
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
			return reportMaxLoad('load-computation-failed', `load computation failed: ${error?.message ?? error}`);
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
