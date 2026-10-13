const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

const cfg = server.config?.akamaiStatus ?? {};

function positiveNumber(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

const aggregatePeriodSeconds = positiveNumber(server.config?.analytics?.aggregatePeriod, 60);

const configuredWorkers = positiveNumber(server.workerCount, positiveNumber(server.config?.threads?.count, 0));
const WORKER_COUNT = configuredWorkers || 1;
if (!configuredWorkers) {
	logger.warn(
		'akamai-status: worker count unknown (no server.workerCount or threads.count), reporting load per node as if it had one worker'
	);
}

const CONFIG = {
	scale: positiveNumber(cfg.loadThresholds?.scale, 1000),
	// Reported when load cannot be measured, so GTM shifts traffic away. The GTM resource's upper
	// bound must be 0 or at least this value.
	max: positiveNumber(cfg.loadThresholds?.max, 100000),
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

function queryMetric(metric, now) {
	// Both bounds, so core pins the primary-key range instead of decoding the metric's whole history.
	return server.operation({
		operation: 'get_analytics',
		metric,
		start_time: now - CONFIG.analyticsWindow,
		end_time: now,
	});
}

async function getBusyFraction() {
	// Analytics rows are attributed to server.hostname; replication.hostname can be unset.
	const nodeName = server.hostname;
	const now = Date.now();
	const [durations, health] = await Promise.all([queryMetric('duration', now), queryMetric('resource-usage', now)]);

	// Core stamps every duration row of a cycle with the cycle's time, so the newest time is the
	// newest cycle however close together two cycles were written.
	let newestTime = null;
	let newestId = null;
	let cyclePeriod = null;
	let busyMs = 0;
	let malformed = null;
	for await (const record of durations) {
		if (record.node !== nodeName) continue;
		const time = Number(record.time);
		if (!Number.isFinite(time)) throw new Error(`duration row for ${record.path} has no time`);
		if (newestTime === null || time > newestTime) {
			newestTime = time;
			cyclePeriod = null;
			busyMs = 0;
			malformed = null;
		}
		if (newestId === null || record.id > newestId) newestId = record.id;
		if (time !== newestTime) continue;
		// A newest-cycle row without a numeric count, or with responses but no mean, is a changed
		// contract: fail closed rather than report idle. Older cycles are not this node's load, so
		// their rows are not judged.
		const { count, mean } = record;
		if (typeof count !== 'number' || !Number.isFinite(count)) malformed ??= `duration row for ${record.path} has no count`;
		else if (count > 0 && (typeof mean !== 'number' || !Number.isFinite(mean)))
			malformed ??= `duration row for ${record.path} has no mean`;
		else busyMs += count * (mean || 0);
		cyclePeriod ??= Number(record.period) || null;
	}
	// A cycle writes its resource-usage row after its duration rows, requests or not, so a second
	// one after the newest duration row means a later cycle ran and found no requests.
	let usageRowsAfter = 0;
	let sawUsage = false;
	for await (const record of health) {
		if (record.node !== nodeName) continue;
		sawUsage = true;
		if (newestId !== null && record.id >= newestId) usageRowsAfter++;
	}

	// No rows of either metric: analytics are not being written, or this node was down for longer
	// than the window.
	if (newestTime === null) return sawUsage ? 0 : null;
	if (usageRowsAfter >= 2) return 0;
	if (malformed) throw new Error(malformed);

	const periodMs = cyclePeriod || aggregatePeriodSeconds * 1000;
	return busyMs / periodMs / WORKER_COUNT;
}

async function computeLoad() {
	let busy;
	try {
		busy = await getBusyFraction();
	} catch (error) {
		return reportMaxLoad('analytics-query-failed', `busy time unavailable: ${error?.message ?? error}`);
	}

	if (busy === null) {
		return reportMaxLoad(
			'analytics-missing',
			'no analytics rows for this node; check that analytics are being written and that node.hostname matches this node'
		);
	}

	clearDegraded();
	const scaled = Math.round(busy * CONFIG.scale);
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
 * Returns server load for Akamai in format "load:N", from in-flight handler work.
 */
export class current_load_for_gtm extends Resource {
	allowRead() {
		return true;
	}

	async get() {
		// Without an explicit content type Harper serializes the bare string to JSON, and GTM's
		// leader-string parse sees a quoted body.
		return { contentType: 'text/plain', data: `${CONFIG.prefix}${await getLoad()}` };
	}
}
