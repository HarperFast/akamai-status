const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

const cfg = server.config?.akamaiStatus ?? {};

//non-finite or non-positive config would turn loads and windows into NaN/Infinity
function positiveNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const aggregatePeriodSeconds = positiveNumber(server.config?.analytics?.aggregatePeriod, 60);

//http workers serve requests; the main thread does not. server.workerCount is the documented
//partitioning idiom (hash % server.workerCount); threads.count is the configured fallback
const WORKER_COUNT = positiveNumber(server.workerCount ?? server.config?.threads?.count, 1);
if (!positiveNumber(server.workerCount ?? server.config?.threads?.count, 0)) {
	logger.warn(
		'akamai-status: worker count unknown (no server.workerCount or threads.count), reporting load per node as if it had one worker'
	);
}

const CONFIG = {
	//load reported for one request continuously in flight per worker; GTM treats loads as unit-less
	scale: positiveNumber(cfg.loadThresholds?.scale, 1000),
	//reported when load cannot be measured, so GTM shifts traffic away; must stay below the GTM resource's upper bound
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

//groups one cycle's rows, which are written in a tight loop; cycles are at least half a period apart
//capped at a quarter period so a small aggregatePeriod can't pull in the previous cycle
const CYCLE_MARGIN_MS = Math.min(5000, (aggregatePeriodSeconds * 1000) / 4);

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
	//both bounds set so core pins the primary-key range instead of decoding the metric's whole history
	const now = Date.now();
	return server.operation({
		operation: 'get_analytics',
		metric,
		start_time: now - CONFIG.analyticsWindow,
		end_time: now,
	});
}

//returns this node's handler work in flight per worker over the newest aggregation cycle, 0 when idle, null when analytics are missing
async function getBusyFraction() {
	//analytics rows are attributed to server.hostname; replication.hostname can be unset
	const nodeName = server.hostname;

	//a duration row is one path+method's response count and mean handler time for the cycle
	//the newest id across both metrics dates the newest cycle; a resource-usage row is written every cycle, requests or not
	const rows = [];
	let newestId = null;
	const [durations, health] = await Promise.all([queryMetric('duration'), queryMetric('resource-usage')]);
	for await (const record of durations) {
		if (record.node !== nodeName) continue;
		rows.push(record);
		if (newestId === null || record.id > newestId) newestId = record.id;
	}
	for await (const record of health) {
		if (record.node === nodeName && (newestId === null || record.id > newestId)) newestId = record.id;
	}

	//no rows of either metric = dead analytics, or a node that was down for longer than the window
	if (newestId === null) return null;

	const cycleRows = rows.filter((record) => newestId - record.id <= CYCLE_MARGIN_MS);
	if (cycleRows.length === 0) return 0;

	//count x mean = milliseconds of handler time; over the period and the workers it is the work in flight per worker
	//a row without a numeric count, or with responses but no mean, is a changed contract: fail closed rather than report idle
	let busyMs = 0;
	for (const record of cycleRows) {
		const { count, mean } = record;
		if (typeof count !== 'number' || !Number.isFinite(count))
			throw new Error(`duration row for ${record.path} has no count`);
		if (count > 0 && (typeof mean !== 'number' || !Number.isFinite(mean)))
			throw new Error(`duration row for ${record.path} has no mean`);
		busyMs += count * (mean || 0);
	}
	const periodMs = Number(cycleRows[0].period) || aggregatePeriodSeconds * 1000;
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
		//explicit text content type, otherwise harper serializes the bare string to json and GTM's load: leader-string parse sees a quoted body
		return { contentType: 'text/plain', data: `${CONFIG.prefix}${await getLoad()}` };
	}
}
