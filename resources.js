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

// A window shorter than GTM's 30 s poll interval can hold no report on an idle node and flap to
// max; one longer than what core retains divides by time it cannot see. Core reads
// analytics.rawRetentionMs as one hour when unset and keeps at least one aggregation period.
const GTM_POLL_MS = 30_000;
const configuredRetentionMs = Number(server.config?.analytics?.rawRetentionMs ?? 3_600_000);
const retainedMs = Math.max(
	Number.isFinite(configuredRetentionMs) ? configuredRetentionMs : 3_600_000,
	aggregatePeriodSeconds * 1000
);
const requestedWindowMs = positiveNumber(cfg.loadThresholds?.windowSeconds, aggregatePeriodSeconds) * 1000;
const windowMs = Math.min(Math.max(requestedWindowMs, Math.min(GTM_POLL_MS, retainedMs)), retainedMs);
if (windowMs !== requestedWindowMs) {
	logger.warn(
		`akamai-status: load window of ${requestedWindowMs / 1000}s clamped to ${windowMs / 1000}s (GTM polls every 30s; core keeps analytics.rawRetentionMs, at least one aggregation period)`
	);
}

const scale = positiveNumber(cfg.loadThresholds?.scale, 1000);
const CONFIG = {
	scale,
	// Reported when load cannot be measured, so GTM shifts traffic away. The GTM resource's upper
	// bound must be 0 or at least this value.
	max: positiveNumber(cfg.loadThresholds?.max, scale),
	prefix: 'load:',
	window: windowMs,
	cacheTtl: Math.max(windowMs / 2, 2000),
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

// harper-pro samples with its profiler in short windows and flags each report that overlapped one,
// because sampling inflates that report's utilization.
const PROFILER_SAMPLING = 'profiler-sampling';
const NO_REPORTS = Symbol('no reports');
const MOSTLY_SAMPLED = Symbol('mostly sampled');
const JUST_STARTED = Symbol('just started');

// Reports written before this worker loaded the component belong to a previous run of the node.
const loadedAt = Date.now();

function isNonNegativeNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function getBusyFraction() {
	const now = Date.now();
	const windowStart = now - CONFIG.window;
	const countedFrom = Math.max(windowStart, loadedAt);
	const reports = await databases.system.hdb_raw_analytics.search({
		conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: windowStart }],
	});
	let sawReport = false;
	let sawUtilization = false;
	let busyMs = 0;
	let sampledMs = 0;
	for await (const report of reports) {
		if (report.id < loadedAt) continue;
		sawReport = true;
		const metrics = report.metrics ?? [];
		// Core attaches utilization to worker threads' reports; the main thread's carry none.
		const utilization = metrics.find((entry) => entry.metric === 'utilization');
		if (!utilization) continue;
		const { active, idle } = utilization;
		if (!isNonNegativeNumber(active) || !isNonNegativeNumber(idle))
			throw new Error(`utilization entry in report ${report.id} has no active or idle time`);
		sawUtilization = true;
		// The sample covers the worker's time since its previous report, which can start before the
		// window; only the part inside it counts.
		const spanMs = active + idle;
		const insideMs = Math.min(spanMs, report.id - countedFrom);
		if (!(insideMs > 0)) continue;
		if (metrics.some((entry) => entry.metric === PROFILER_SAMPLING)) sampledMs += insideMs;
		else busyMs += (active * insideMs) / spanMs;
	}
	// Core writes a report only for a worker that recorded something, and GTM's own polls are
	// requests, so a window without reports means analytics are not being written.
	if (!sawReport) return now - loadedAt < CONFIG.window ? JUST_STARTED : NO_REPORTS;
	if (!sawUtilization) throw new Error('no report in the window carries event-loop utilization');
	// A worker without a report in the window recorded nothing and counts as idle.
	const measuredMs = (now - countedFrom) * WORKER_COUNT - sampledMs;
	if (measuredMs < CONFIG.window) return sampledMs > 0 ? MOSTLY_SAMPLED : JUST_STARTED;
	return busyMs / measuredMs;
}

async function computeLoad() {
	let busy;
	try {
		busy = await getBusyFraction();
	} catch (error) {
		return reportMaxLoad('analytics-query-failed', `busy time unavailable: ${error?.message ?? error}`);
	}

	if (busy === NO_REPORTS) {
		return reportMaxLoad(
			'analytics-missing',
			`no analytics reports in the last ${CONFIG.window / 1000}s; check that analytics are enabled and being written`
		);
	}
	// One episode either way: right after a start the profiler is usually sampling too.
	if (busy === MOSTLY_SAMPLED || busy === JUST_STARTED) {
		return reportMaxLoad(
			'too-little-measured',
			busy === MOSTLY_SAMPLED
				? `harper-pro's profiler sampled most of the last ${CONFIG.window / 1000}s, which inflates event-loop utilization`
				: `less than one worker's ${CONFIG.window / 1000}s window measured since this component started`
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
	static hidden = true;

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
 * Returns server load for Akamai in format "load:N", from the HTTP workers' event-loop utilization.
 */
export class current_load_for_gtm extends Resource {
	static hidden = true;

	allowRead() {
		return true;
	}

	async get() {
		// Without an explicit content type Harper serializes the bare string to JSON, and GTM's
		// leader-string parse sees a quoted body.
		return { contentType: 'text/plain', data: `${CONFIG.prefix}${await getLoad()}` };
	}
}
