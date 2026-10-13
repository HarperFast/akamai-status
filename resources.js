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

const CONFIG = {
	scale: positiveNumber(cfg.loadThresholds?.scale, 1000),
	// Reported when load cannot be measured, so GTM shifts traffic away. The GTM resource's upper
	// bound must be 0 or at least this value.
	max: positiveNumber(cfg.loadThresholds?.max, 100000),
	prefix: 'load:',
	window: windowMs,
	// Half the window matches GTM's 30 s poll interval; every worker scans the window on a miss.
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

// The raw table is written per node and never replicated, so the scan is bounded by this node's
// workers, not the cluster.
async function getBusyFraction() {
	const reports = await databases.system.hdb_raw_analytics.search({
		conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: Date.now() - CONFIG.window }],
	});
	let sawReport = false;
	let busyMs = 0;
	for await (const report of reports) {
		sawReport = true;
		for (const entry of report.metrics ?? []) {
			if (entry.metric !== 'duration') continue;
			// An entry without a numeric count, or with responses but no mean, is a changed contract:
			// fail closed rather than report idle.
			const { count, mean } = entry;
			if (typeof count !== 'number' || !Number.isFinite(count))
				throw new Error(`duration entry for ${entry.path} has no count`);
			if (count > 0 && (typeof mean !== 'number' || !Number.isFinite(mean)))
				throw new Error(`duration entry for ${entry.path} has no mean`);
			busyMs += count * (mean || 0);
		}
	}
	// Core writes a report only for a worker that recorded something, and GTM's own polls are
	// requests, so a window without reports means analytics are not being written.
	if (!sawReport) return null;
	return busyMs / CONFIG.window / WORKER_COUNT;
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
			`no analytics reports in the last ${CONFIG.window / 1000}s; check that analytics are enabled and being written`
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
