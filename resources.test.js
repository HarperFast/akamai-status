/**
 * Harper injects `server`, `logger`, `databases` and `Resource` as globals, so they are stubbed here
 * before resources.js is imported. Run with: npm test
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

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

const { status, current_load_for_gtm } = await import('./resources.js');

function duration(path, count, mean, method = 'GET') {
	return { metric: 'duration', path, method, count, mean };
}

// One worker's report for the second ending at `id`, the shape core writes to hdb_raw_analytics.
function report(id, threadId, metrics) {
	return { id, time: Math.floor(id), period: 1000.2, threadId, metrics };
}

function windowReports() {
	return [
		report(1_000_000 - 50_000, 1, [
			duration('/resource', 4_000, 2),
			{ metric: 'success', path: '/resource', total: 4_000, count: 4_000 },
		]),
		report(1_000_000 - 40_000, 2, [duration('/resource', 3_000, 10, 'POST')]),
		report(1_000_000 - 30_000, 1, [
			duration('/resource', 5_000, 2),
			{ metric: 'memory', threadId: 1, byThread: true, rss: 1 },
		]),
		report(1_000_000 - 20_000, 2, [{ metric: 'utilization', idle: 1, active: 1, utilization: 0.5 }]),
	];
}

async function* asyncIterable(rows) {
	for (const row of rows) yield row;
}

function serving(reports) {
	return () => asyncIterable(reports);
}

// Verbatim hdb_raw_analytics rows: the suite proves core's report contract, not a model of it.
function capturedReports(name) {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

function busyMsOf(reports) {
	let busy = 0;
	for (const { metrics } of reports) {
		for (const entry of metrics) if (entry.metric === 'duration') busy += entry.count * entry.mean;
	}
	return busy;
}

async function loadBody() {
	const response = await new current_load_for_gtm().get();
	return response.data;
}

// This suite runs on the main thread, where a single-threaded node runs the component. A node with
// worker threads runs it on a worker, so that case loads its own module instance on one.
function loadOnWorker(reports) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			`
			const { parentPort, workerData } = require('node:worker_threads');
			globalThis.logger = { warn() {}, info() {}, error() {}, notify() {}, trace() {}, debug() {} };
			globalThis.Resource = class {};
			globalThis.server = { workerCount: 2, config: {} };
			globalThis.databases = {
				system: { hdb_raw_analytics: { search: async function* () { yield* workerData.reports; } } },
			};
			import(workerData.module).then(
				async ({ current_load_for_gtm }) => parentPort.postMessage((await new current_load_for_gtm().get()).data),
				(error) => parentPort.postMessage('import failed: ' + error.message)
			);
			`,
			{ eval: true, workerData: { reports, module: new URL('./resources.js', import.meta.url).href } }
		);
		worker.once('message', (body) => {
			worker.terminate();
			resolve(body);
		});
		worker.once('error', reject);
	});
}

// Degraded state is module-level and deliberately persists across polls, so a test that asserts
// warning counts has to start from a known-healthy state rather than whatever ran before it.
async function startHealthy() {
	searchHandler = serving(windowReports());
	now += 60_000;
	await loadBody();
	warnings.length = 0;
}

let now = 1_000_000;
const realDateNow = Date.now;

describe('current_load_for_gtm', () => {
	beforeEach(() => {
		warnings.length = 0;
		now += 60_000;
		Date.now = () => now;
	});

	afterEach(() => {
		Date.now = realDateNow;
	});

	it("sums handler time over every worker's reports in the window and divides by the window and the worker count", async () => {
		searchHandler = serving(windowReports());

		assert.equal(await loadBody(), 'load:400');
	});

	it("returns a plain text body so GTM's leader-string parse sees load:N unquoted", async () => {
		searchHandler = serving(windowReports());

		const response = await new current_load_for_gtm().get();
		assert.equal(response.contentType, 'text/plain');
		assert.match(response.data, /^load:\d+$/);
	});

	it('reports more than scale when every worker is more than continuously busy, and only max clamps it', async () => {
		searchHandler = serving([report(now - 1_000, 1, [duration('/resource', 180_000, 1)])]);
		assert.equal(await loadBody(), 'load:1500');

		now += 60_000;
		searchHandler = serving([report(now - 1_000, 1, [duration('/resource', 240_000, 100)])]);
		assert.equal(await loadBody(), 'load:100000');
	});

	it('weights requests by handler time, so an expensive request counts for more than a cheap one', async () => {
		searchHandler = serving([
			report(now - 2_000, 1, [duration('/cached', 1_000, 1)]),
			report(now - 1_000, 2, [duration('/query', 1_000, 50)]),
		]);

		assert.equal(await loadBody(), 'load:425');
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
		// CONFIG is built at import time, so load a second module instance under the config.
		server.config = { akamaiStatus: { loadThresholds: { windowSeconds: 30 } } };
		const { current_load_for_gtm: shortWindow } = await import('./resources.js?window=30');
		server.config = {};
		const requests = [];
		searchHandler = (received) => {
			requests.push(received);
			return asyncIterable(windowReports());
		};

		assert.equal((await new shortWindow().get()).data, 'load:800');
		assert.equal(requests[0].conditions[0].value, now - 30_000);
	});

	it('clamps the window to the GTM poll interval below and the raw retention above, and says so', async () => {
		server.config = { akamaiStatus: { loadThresholds: { windowSeconds: 5 } } };
		warnings.length = 0;
		const { current_load_for_gtm: tooShort } = await import('./resources.js?window=5');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /5s clamped to 30s/);

		server.config = {
			analytics: { rawRetentionMs: 120_000 },
			akamaiStatus: { loadThresholds: { windowSeconds: 600 } },
		};
		warnings.length = 0;
		const { current_load_for_gtm: tooLong } = await import('./resources.js?window=600');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /600s clamped to 120s/);

		// Core keeps at least one aggregation period, so a retention below the period does not shrink
		// the floor past the period, and a period under 30 s does.
		server.config = {
			analytics: { aggregatePeriod: 10, rawRetentionMs: 5_000 },
			akamaiStatus: { loadThresholds: { windowSeconds: 60 } },
		};
		warnings.length = 0;
		await import('./resources.js?window=short-period');
		assert.match(warnings[0], /60s clamped to 10s/);

		// rawRetentionMs of 0 means one period to core, not the one-hour default.
		server.config = { analytics: { rawRetentionMs: 0 }, akamaiStatus: { loadThresholds: { windowSeconds: 600 } } };
		warnings.length = 0;
		await import('./resources.js?window=zero-retention');
		server.config = {};
		assert.match(warnings[0], /600s clamped to 60s/);

		const requests = [];
		searchHandler = (received) => {
			requests.push(received);
			return asyncIterable(windowReports());
		};
		assert.equal((await new tooShort().get()).data, 'load:800');
		assert.equal(requests.at(-1).conditions[0].value, now - 30_000);
		assert.equal((await new tooLong().get()).data, 'load:200');
		assert.equal(requests.at(-1).conditions[0].value, now - 120_000);
	});

	it('divides by threads.count when server.workerCount is absent, and by one when neither is set', async () => {
		// WORKER_COUNT is read at import, so each case loads its own module instance.
		const savedCount = server.workerCount;
		delete server.workerCount;
		server.config = { threads: { count: 4 } };
		const { current_load_for_gtm: fourWorkers } = await import('./resources.js?workers=config');
		server.config = {};
		const { current_load_for_gtm: oneWorker } = await import('./resources.js?workers=none');
		server.workerCount = savedCount;
		warnings.length = 0;
		searchHandler = serving(windowReports());

		assert.equal((await new fourWorkers().get()).data, 'load:200');
		assert.equal((await new oneWorker().get()).data, 'load:800');
	});

	it('warns once at load when the worker count cannot be determined', async () => {
		const savedCount = server.workerCount;
		delete server.workerCount;
		server.config = {};
		warnings.length = 0;
		await import('./resources.js?workers=unknown');
		server.workerCount = savedCount;

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /worker count unknown/);
	});

	it('falls back to safe defaults when threshold, window or period config is not a finite positive number', async () => {
		server.config = {
			analytics: { aggregatePeriod: 'soon' },
			akamaiStatus: { loadThresholds: { scale: 'abc', max: -5, windowSeconds: 0 } },
		};
		const { current_load_for_gtm: misconfigured } = await import('./resources.js?config=invalid');
		server.config = {};
		searchHandler = serving(windowReports());

		assert.equal((await new misconfigured().get()).data, 'load:400');
	});

	it('reports max load, not idle, when a duration entry lacks a numeric count or mean', async () => {
		// A changed report contract must fail closed: load:0 would attract traffic to a node whose
		// load is unknown.
		const { count, ...noCount } = duration('/resource', 9_000, 2);
		searchHandler = serving([report(now - 1_000, 1, [noCount])]);
		assert.equal(await loadBody(), 'load:100000');
		assert.match(warnings.at(-1), /no count/);

		now += 60_000;
		searchHandler = serving(windowReports());
		await loadBody();

		now += 60_000;
		searchHandler = serving([report(now - 1_000, 1, [{ ...duration('/resource', 9_000, 2), mean: null }])]);
		assert.equal(await loadBody(), 'load:100000');
		assert.match(warnings.at(-1), /no mean/);

		// A zero-response entry carries no mean and is not a contract change.
		now += 60_000;
		searchHandler = serving([
			report(now - 1_000, 1, [{ metric: 'duration', path: '/resource', method: 'GET', count: 0 }]),
		]);
		assert.equal(await loadBody(), 'load:0');
	});

	it('reproduces an idle stage node from captured reports', async () => {
		await startHealthy();
		// us-east1-b-1 on lfct1: 60 s of GTM liveness and load polls only, two workers.
		searchHandler = serving(capturedReports('raw-idle-lfct1'));
		now += 60_000;

		assert.equal(await loadBody(), 'load:0');
		assert.equal(warnings.length, 0);
	});

	it('reproduces a busy local node from captured reports', async () => {
		// A local two-worker instance: 2,000 keep-alive GETs and one POST on an exported table,
		// all served by one worker, 300 ms of handler time over the 60 s window.
		const captured = capturedReports('raw-busy-local');
		searchHandler = serving(captured);

		const expected = Math.round((busyMsOf(captured) / 60_000 / 2) * 1000);
		assert.equal(expected, 2);
		assert.equal(await loadBody(), `load:${expected}`);
	});

	it("skips the main thread's reports, where the operations API runs, when the component runs on a worker", async () => {
		// us-east1-b-1's idle window plus a main-thread report of the shape core writes for
		// operations-API calls: a 7.2 s operation, and untyped entries like rejected logins.
		const idle = capturedReports('raw-idle-lfct1');
		const operations = report(now - 1_000, 0, [
			{ metric: 'duration', path: 'get_analytics', type: 'operation', count: 1, mean: 7_200 },
			duration('/', 3, 1, 'POST'),
		]);

		assert.equal(await loadOnWorker([...idle, operations]), 'load:0');
		// The same work in a worker's report counts.
		const expected = Math.round(((busyMsOf(idle) + 7_203) / 60_000 / 2) * 1000);
		assert.equal(expected, 60);
		assert.equal(await loadOnWorker([...idle, { ...operations, threadId: 1 }]), `load:${expected}`);
	});

	it("counts the main thread's reports on a single-threaded node, where that thread serves HTTP", async () => {
		searchHandler = serving([report(now - 1_000, 0, [duration('/resource', 6_000, 10)])]);

		assert.equal(await loadBody(), 'load:500');
	});

	it('reports max load when no report was written in the window', async () => {
		searchHandler = serving([]);

		assert.equal(await loadBody(), 'load:100000');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /no analytics reports in the last 60s/);
	});

	it('reports max load when the raw analytics query fails', async () => {
		searchHandler = () => {
			throw new Error('boom');
		};

		assert.equal(await loadBody(), 'load:100000');
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
		searchHandler = serving(windowReports());
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
