const DEFAULT_200_MSG = 'Status endpoint is reporting for duty.';
const DEFAULT_404_MSG = 'Status endpoint is reporting downtime.';

const cfg = server.config?.akamaiStatus ?? {};

//non-finite or non-positive config would turn loads and windows into NaN/Infinity
function positiveNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const aggregatePeriodSeconds = positiveNumber(server.config?.analytics?.aggregatePeriod, 60);

const CONFIG = {
	scale: positiveNumber(cfg.loadThresholds?.scale, 1000),
	max: positiveNumber(cfg.loadThresholds?.max ?? cfg.loadThresholds?.scale, 1000),
	//request rate that maps to full scale, set per instance size
	targetRps: positiveNumber(cfg.loadThresholds?.targetRps, 1000),
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

//returns this node's request rate from the newest aggregation cycle, 0 when idle, null when analytics are missing
async function getRequestRate() {
	//analytics rows are attributed to server.hostname; replication.hostname can be unset
	const nodeName = server.hostname;

	//a success row's total is every request for that path+method and count only the successful ones
	//the newest id across both metrics dates the newest cycle; a resource-usage row is written every cycle, requests or not
	const rows = [];
	let newestId = null;
	const [requests, health] = await Promise.all([queryMetric('success'), queryMetric('resource-usage')]);
	for await (const record of requests) {
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

	let requestCount = 0;
	for (const record of cycleRows) requestCount += Number(record.total ?? record.count) || 0;
	const periodMs = Number(cycleRows[0].period) || aggregatePeriodSeconds * 1000;
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
		//explicit text content type, otherwise harper serializes the bare string to json and GTM's load: leader-string parse sees a quoted body
		return { contentType: 'text/plain', data: `${CONFIG.prefix}${await getLoad()}` };
	}
}
