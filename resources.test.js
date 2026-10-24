/**
 * Harper injects `server`, `logger`, `databases` and `Resource` as globals, so they are stubbed here
 * before resources.js is imported. Run with: npm test
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const warnings = [];
let operationHandler;
let searchHandler;

globalThis.logger = {
	warn: (message) => warnings.push(message),
	info: () => {},
	error: () => {},
	notify: () => {},
	trace: () => {},
	debug: () => {},
};
globalThis.Resource = class {};
globalThis.server = {
	hostname: 'node-a',
	workerCount: 2,
	config: {},
	operation: (request) => operationHandler(request),
};
globalThis.databases = {
	system: {
		hdb_raw_analytics: {
			search: (request) => searchHandler(request),
		},
	},
};

// A module instance counts reports only from when it loaded, so every instance here loads at a time
// well before the windows the tests ask about.
const realDateNow = Date.now;
let now = 1_000_000;
function importEarlier(specifier, loadedBefore = 3_600_000) {
	const at = now - loadedBefore;
	Date.now = () => at;
	return import(specifier).finally(() => {
		Date.now = () => now;
	});
}

const { status, current_load_for_gtm } = await importEarlier('./resources.js');
Date.now = realDateNow;

function utilization(active, idle) {
	return { metric: 'utilization', idle, active, utilization: active / (active + idle) };
}

const profilerSampling = { metric: 'profiler-sampling', total: 1_000, count: 1 };

function report(id, threadId, metrics) {
	return { id, time: Math.floor(id), period: 1000.2, threadId, metrics };
}

function windowReports() {
	return [
		report(now - 30_000, 1, [
			utilization(12_000, 18_000),
			{ metric: 'duration', path: '/resource', count: 9, mean: 2 },
		]),
		report(now - 10_000, 2, [utilization(24_000, 26_000), { metric: 'memory', threadId: 2, byThread: true, rss: 1 }]),
		report(now - 5_000, 0, [{ metric: 'duration', path: 'describe_all', type: 'operation', count: 1, mean: 7_000 }]),
		report(now - 1_000, 1, [utilization(12_000, 17_000)]),
	];
}

async function* asyncIterable(rows) {
	for (const row of rows) yield row;
}

function serving(reports) {
	return () => asyncIterable(typeof reports === 'function' ? reports() : reports);
}

// Unedited hdb_raw_analytics rows captured from real nodes.
function capturedReports(name) {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

function activeInside(reports, windowStart) {
	let active = 0;
	for (const { id, metrics } of reports) {
		const sample = metrics.find((entry) => entry.metric === 'utilization');
		if (!sample || metrics.some((entry) => entry.metric === 'profiler-sampling')) continue;
		const span = sample.active + sample.idle;
		const inside = Math.min(span, id - windowStart);
		if (inside > 0) active += (sample.active * inside) / span;
	}
	return active;
}

function rebased(reports) {
	const shift = now - Math.max(...reports.map((row) => row.id));
	return reports.map((row) => ({ ...row, id: row.id + shift, time: row.time + shift }));
}

async function loadBody() {
	const response = await new current_load_for_gtm().get();
	return response.data;
}

// Degraded state is module-level and deliberately persists across polls, so a test that asserts
// warning counts has to start from a known-healthy state rather than whatever ran before it.
async function startHealthy() {
	searchHandler = serving(windowReports);
	now += 60_000;
	await loadBody();
	warnings.length = 0;
}

describe('current_load_for_gtm', () => {
	beforeEach(() => {
		warnings.length = 0;
		now += 60_000;
		Date.now = () => now;
	});

	afterEach(() => {
		Date.now = realDateNow;
	});

	it('sums event-loop busy time inside the window over every worker and divides by the window and the worker count', async () => {
		searchHandler = serving(windowReports);

		assert.equal(await loadBody(), 'load:400');
	});

	it("returns a plain text body so GTM's leader-string parse sees load:N unquoted", async () => {
		searchHandler = serving(windowReports);

		const response = await new current_load_for_gtm().get();
		assert.equal(response.contentType, 'text/plain');
		assert.match(response.data, /^load:\d+$/);
	});

	it('reads scale, its ceiling, when every worker is busy the whole window', async () => {
		searchHandler = serving([
			report(now - 1, 1, [utilization(90_000, 0)]),
			report(now - 1, 2, [utilization(60_000, 0)]),
		]);

		assert.equal(await loadBody(), 'load:1000');
	});

	it("counts only the part of a sample's span that falls inside the window", async () => {
		searchHandler = serving([report(now - 55_000, 1, [utilization(10_000, 10_000)])]);

		assert.equal(await loadBody(), 'load:21');
	});

	it('counts a worker that wrote no report in the window as idle', async () => {
		searchHandler = serving([report(now, 1, [utilization(60_000, 0)])]);

		assert.equal(await loadBody(), 'load:500');
	});

	it('asks only for reports written inside the window, by id, so core pins the key range', async () => {
		const requests = [];
		searchHandler = (received) => {
			requests.push(received);
			return asyncIterable(windowReports());
		};

		await loadBody();

		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0], {
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: now - 60_000 }],
		});
	});

	it('uses a configured window for both the query and the denominator', async () => {
		server.config = { akamaiStatus: { loadThresholds: { windowSeconds: 30 } } };
		const { current_load_for_gtm: shortWindow } = await importEarlier('./resources.js?window=30');
		server.config = {};
		const requests = [];
		searchHandler = (received) => {
			requests.push(received);
			return asyncIterable(windowReports());
		};

		assert.equal((await new shortWindow().get()).data, 'load:360');
		assert.equal(requests[0].conditions[0].value, now - 30_000);
	});

	it('clamps the window to the GTM poll interval below and the raw retention above, and says so', async () => {
		server.config = { akamaiStatus: { loadThresholds: { windowSeconds: 5 } } };
		warnings.length = 0;
		const { current_load_for_gtm: tooShort } = await importEarlier('./resources.js?window=5');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /5s clamped to 30s/);

		server.config = {
			analytics: { rawRetentionMs: 120_000 },
			akamaiStatus: { loadThresholds: { windowSeconds: 600 } },
		};
		warnings.length = 0;
		const { current_load_for_gtm: tooLong } = await importEarlier('./resources.js?window=600');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /600s clamped to 120s/);

		// Core keeps at least one aggregation period, so a retention below the period does not shrink
		// the floor past the period, and a period under 30 s does.
		server.config = {
			analytics: { aggregatePeriod: 10, rawRetentionMs: 5_000 },
			akamaiStatus: { loadThresholds: { windowSeconds: 60 } },
		};
		warnings.length = 0;
		await importEarlier('./resources.js?window=short-period');
		assert.match(warnings[0], /60s clamped to 10s/);

		// rawRetentionMs of 0 means one period to core, not the one-hour default.
		server.config = { analytics: { rawRetentionMs: 0 }, akamaiStatus: { loadThresholds: { windowSeconds: 600 } } };
		warnings.length = 0;
		await importEarlier('./resources.js?window=zero-retention');
		server.config = {};
		assert.match(warnings[0], /600s clamped to 60s/);

		const requests = [];
		searchHandler = (received) => {
			requests.push(received);
			return asyncIterable(windowReports());
		};
		assert.equal((await new tooShort().get()).data, 'load:360');
		assert.equal(requests.at(-1).conditions[0].value, now - 30_000);
		assert.equal((await new tooLong().get()).data, 'load:200');
		assert.equal(requests.at(-1).conditions[0].value, now - 120_000);
	});

	it('divides by threads.count when server.workerCount is absent, and by one when neither is set', async () => {
		const savedCount = server.workerCount;
		delete server.workerCount;
		server.config = { threads: { count: 4 } };
		const { current_load_for_gtm: fourWorkers } = await importEarlier('./resources.js?workers=config');
		server.config = {};
		const { current_load_for_gtm: oneWorker } = await importEarlier('./resources.js?workers=none');
		server.workerCount = savedCount;
		warnings.length = 0;
		searchHandler = serving(windowReports);

		assert.equal((await new fourWorkers().get()).data, 'load:200');
		assert.equal((await new oneWorker().get()).data, 'load:800');
	});

	it('warns once at load when the worker count cannot be determined', async () => {
		const savedCount = server.workerCount;
		delete server.workerCount;
		server.config = {};
		warnings.length = 0;
		await importEarlier('./resources.js?workers=unknown');
		server.workerCount = savedCount;

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /worker count unknown/);
	});

	it('falls back to safe defaults when threshold, window or period config is not a finite positive number', async () => {
		server.config = {
			analytics: { aggregatePeriod: 'soon' },
			akamaiStatus: { loadThresholds: { scale: 'abc', max: -5, windowSeconds: 0 } },
		};
		const { current_load_for_gtm: misconfigured } = await importEarlier('./resources.js?config=invalid');
		server.config = {};
		searchHandler = serving(windowReports);

		assert.equal((await new misconfigured().get()).data, 'load:400');
	});

	it('leaves reports flagged by the profiler out of both the busy time and the time it divides by', async () => {
		searchHandler = serving([
			report(now, 1, [utilization(50_000, 10_000), profilerSampling]),
			report(now, 2, [utilization(6_000, 54_000)]),
		]);

		assert.equal(await loadBody(), 'load:100');
	});

	it('ignores reports from before the component started, and reads max until it has measured a window', async () => {
		const { current_load_for_gtm: restarted } = await importEarlier('./resources.js?restart', 20_000);
		warnings.length = 0;
		searchHandler = serving(windowReports);
		assert.equal((await new restarted().get()).data, 'load:1000');
		assert.match(warnings.at(-1), /since this component started/);

		// Half a window after loading, the previous run's reports alone must not read as idle.
		const { current_load_for_gtm: halfWindow } = await importEarlier('./resources.js?restart-half', 30_000);
		searchHandler = serving([report(now - 40_000, 1, [utilization(1_000, 9_000)])]);
		assert.equal((await new halfWindow().get()).data, 'load:1000');

		now += 40_000;
		searchHandler = serving([report(now, 1, [utilization(30_000, 30_000)]), report(now, 2, [utilization(0, 60_000)])]);
		assert.equal((await new restarted().get()).data, 'load:250');
	});

	it('reports max load while the profiler sampled most of the window', async () => {
		searchHandler = serving([
			report(now, 1, [utilization(42_000, 18_000), profilerSampling]),
			report(now, 2, [utilization(40_000, 20_000), profilerSampling]),
		]);

		assert.equal(await loadBody(), 'load:1000');
		assert.match(warnings.at(-1), /profiler sampled most of the last 60s/);
	});

	it('reports max load, not idle, when a utilization entry lacks numeric active or idle time', async () => {
		const { active, ...noActive } = utilization(1_000, 2_000);
		searchHandler = serving([report(now - 1_000, 1, [noActive])]);
		assert.equal(await loadBody(), 'load:1000');
		assert.match(warnings.at(-1), /no active or idle time/);

		now += 60_000;
		searchHandler = serving([report(now - 1_000, 1, [{ ...utilization(1_000, 2_000), idle: null }])]);
		assert.equal(await loadBody(), 'load:1000');
	});

	it('reports max load when the reports in the window carry no utilization, as on a single-threaded node', async () => {
		await startHealthy();
		now += 60_000;
		searchHandler = serving([report(now - 1_000, 0, [{ metric: 'duration', path: '/resource', count: 6, mean: 10 }])]);

		assert.equal(await loadBody(), 'load:1000');
		assert.match(warnings.at(-1), /carries event-loop utilization/);
	});

	it('reproduces an idle harper-pro node from captured reports, after its startup sampling', async () => {
		await startHealthy();
		now += 60_000;
		// Two workers, GTM-like polls only, harper-pro with the profiler's sampling window.
		const captured = rebased(capturedReports('raw-idle-pro'));
		searchHandler = serving(captured);

		const expected = Math.round((activeInside(captured, now - 60_000) / 120_000) * 1000);
		assert.ok(expected <= 10, `idle reads ${expected}`);
		assert.equal(await loadBody(), `load:${expected}`);
		assert.equal(warnings.length, 0);
	});

	it('reports max load during the profiler sampling right after a harper-pro start', async () => {
		const captured = rebased(capturedReports('raw-startup-pro'));
		searchHandler = serving(captured);

		assert.ok(
			captured.every(
				(row) =>
					!row.metrics.some((entry) => entry.metric === 'utilization') ||
					row.metrics.some((entry) => entry.metric === 'profiler-sampling')
			)
		);
		assert.equal(await loadBody(), 'load:1000');
	});

	it('reads the profiler-inflated idle of harper-pro 5.3 as busy, which is why it needs the profiler fix', async () => {
		// us-east1-b-1 on lfct1, harper-pro 5.3.0 with profiling on: 60 s of GTM polls only.
		const captured = rebased(capturedReports('raw-idle-lfct1'));
		searchHandler = serving(captured);

		const expected = Math.round((activeInside(captured, now - 60_000) / 120_000) * 1000);
		assert.ok(expected > 600, `5.3 idle reads ${expected}`);
		assert.equal(await loadBody(), `load:${expected}`);
	});

	it('reproduces a busy local node from captured reports', async () => {
		// A local two-worker core instance, no profiler: 2,000 keep-alive GETs and one POST on an
		// exported table, all served by one worker.
		const captured = rebased(capturedReports('raw-busy-local'));
		searchHandler = serving(captured);

		const expected = Math.round((activeInside(captured, now - 60_000) / 120_000) * 1000);
		assert.ok(expected > 0, `busy reads ${expected}`);
		assert.equal(await loadBody(), `load:${expected}`);
	});

	it('reports max load when no report was written in the window', async () => {
		searchHandler = serving([]);

		assert.equal(await loadBody(), 'load:1000');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /no analytics reports in the last 60s/);
	});

	it('reports max load when the raw analytics query fails', async () => {
		searchHandler = () => {
			throw new Error('boom');
		};

		assert.equal(await loadBody(), 'load:1000');
	});

	it('warns once per degraded episode, not once per poll', async () => {
		await startHealthy();
		searchHandler = () => {
			throw new Error('boom');
		};

		for (let poll = 0; poll < 5; poll++) {
			now += 60_000;
			await loadBody();
		}

		assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}: ${warnings.join(' | ')}`);
	});

	it('treats one wedged-analytics episode as one episode even as the error text varies', async () => {
		await startHealthy();
		let attempt = 0;
		searchHandler = () => {
			throw new Error(`timed out after ${attempt++}ms`);
		};

		for (let poll = 0; poll < 5; poll++) {
			now += 60_000;
			await loadBody();
		}

		assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}: ${warnings.join(' | ')}`);
	});

	it('warns again on recovery so the degraded state has a visible end', async () => {
		await startHealthy();
		searchHandler = () => {
			throw new Error('boom');
		};
		now += 60_000;
		await loadBody();

		now += 60_000;
		searchHandler = serving(windowReports);
		assert.equal(await loadBody(), 'load:400');

		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /recovered/);
	});

	it('shares one scan across concurrent polls', async () => {
		let queries = 0;
		searchHandler = () => {
			queries++;
			return asyncIterable(windowReports());
		};

		const results = await Promise.all(Array.from({ length: 10 }, () => loadBody()));

		assert.equal(queries, 1);
		assert.deepEqual(new Set(results), new Set(['load:400']));
	});

	it('serves the cached value inside the TTL and recomputes after it', async () => {
		let queries = 0;
		searchHandler = () => {
			queries++;
			return asyncIterable(windowReports());
		};

		await loadBody();
		now += 20_000;
		await loadBody();
		assert.equal(queries, 1);

		now += 20_000;
		await loadBody();
		assert.equal(queries, 2);
	});
});

describe('status', () => {
	beforeEach(() => {
		warnings.length = 0;
	});

	it('returns the ready message when availability is Available', async () => {
		operationHandler = () => ({ status: 'Available' });

		assert.match(await new status().get(), /reporting for duty/);
	});

	it('throws a 404 when availability is anything else', async () => {
		operationHandler = () => ({ status: 'Unavailable' });

		await assert.rejects(
			() => new status().get(),
			(error) => error.statusCode === 404
		);
	});

	it('throws a 404 when no availability status is set at all', async () => {
		operationHandler = () => undefined;

		await assert.rejects(
			() => new status().get(),
			(error) => error.statusCode === 404
		);
	});

	it('sets availability through the operations API', async () => {
		const requests = [];
		operationHandler = (request) => {
			requests.push(request);
		};

		await new status().post();
		await new status().delete();

		assert.deepEqual(requests, [
			{ operation: 'set_status', id: 'availability', status: 'Available' },
			{ operation: 'set_status', id: 'availability', status: 'Unavailable' },
		]);
	});
});

describe('MCP and OpenAPI exposure', () => {
	for (const [name, ResourceClass] of Object.entries({ status, current_load_for_gtm })) {
		it(`hides ${name} from MCP tools and the OpenAPI document`, () => {
			assert.strictEqual(ResourceClass.hidden, true);
		});

		it(`keeps ${name} readable without credentials, as Akamai polls it anonymously`, () => {
			assert.strictEqual(new ResourceClass().allowRead(), true);
		});
	}

	it('leaves POST and DELETE /status on the default super_user-only authorization', () => {
		assert.strictEqual(Object.hasOwn(status.prototype, 'allowCreate'), false);
		assert.strictEqual(Object.hasOwn(status.prototype, 'allowDelete'), false);
	});
});
