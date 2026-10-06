/**
 * Harper injects `server`, `logger` and `Resource` as globals, so they are stubbed here before
 * resources.js is imported. Run with: npm test
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

const warnings = [];
let operationHandler;

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
	config: {},
	operation: (request) => operationHandler(request),
};

const { status, current_load_for_gtm } = await import('./resources.js');

function successRow(node, id, count, path = '/resource', method = 'GET') {
	return { node, id, count, path, method, metric: 'success', period: 60_000 };
}

function resourceUsageRow(node, id) {
	return { node, id, metric: 'resource-usage', period: 60_000 };
}

//newest node-a cycle sums to 12,000 requests over 60s = 200 req/s; the previous cycle must not be summed in
function analyticsRows() {
	return [
		successRow('node-b', 200_002, 999_999),
		successRow('node-a', 140_000, 60_000),
		successRow('node-a', 200_000, 9_000, '/resource', 'GET'),
		successRow('node-a', 200_001, 3_000, '/resource', 'POST'),
	];
}

async function* asyncIterable(rows) {
	for (const row of rows) yield row;
}

//verbatim get_analytics rows from a stage node, so the suite proves core's row contract, not a model of it
function capturedStageRows() {
	const node = 'q1r-us-east1-b-1.lfct1.devin-enterprise.stage.harperfabric.com';
	const success = [
		{
			id: 1791286787784.3342,
			period: 60000,
			metric: 'success',
			path: 'status',
			method: 'GET',
			total: 38,
			count: 38,
			ratio: 1,
			time: 1791286787574.0132,
			node,
		},
		{
			id: 1791286787786.2764,
			period: 60000,
			metric: 'success',
			path: 'current_load_for_gtm',
			method: 'GET',
			total: 6,
			count: 6,
			ratio: 1,
			time: 1791286787574.0132,
			node,
		},
		{
			id: 1791286877786.0164,
			period: 60000,
			metric: 'success',
			path: 'status',
			method: 'GET',
			total: 42,
			count: 42,
			ratio: 1,
			time: 1791286848102.2234,
			node,
		},
		{
			id: 1791286877788.3594,
			period: 60000,
			metric: 'success',
			path: 'current_load_for_gtm',
			method: 'GET',
			total: 6,
			count: 6,
			ratio: 1,
			time: 1791286848102.2234,
			node,
		},
		{
			id: 1791286907785.8613,
			period: 60000,
			metric: 'success',
			path: 'status',
			method: 'GET',
			total: 40,
			count: 40,
			ratio: 1,
			time: 1791286907209.8142,
			node,
		},
		{
			id: 1791286907788.0466,
			period: 60000,
			metric: 'success',
			path: 'current_load_for_gtm',
			method: 'GET',
			total: 4,
			count: 4,
			ratio: 1,
			time: 1791286907209.8142,
			node,
		},
	];
	const resourceUsage = [
		{
			id: 1791286787787.3945,
			metric: 'resource-usage',
			userCPUTime: 204.5109999999404,
			systemCPUTime: 68.16599999996834,
			minorPageFault: 4,
			majorPageFault: 0,
			fsRead: 0,
			fsWrite: 16,
			voluntaryContextSwitches: 3057,
			involuntaryContextSwitches: 206,
			time: 1791286787787,
			period: 29999,
			cpuUtilization: 0.01,
			node,
		},
		{
			id: 1791286877789.2952,
			metric: 'resource-usage',
			userCPUTime: 486.3029999998398,
			systemCPUTime: 226.2609999999404,
			minorPageFault: 6,
			majorPageFault: 0,
			fsRead: 0,
			fsWrite: 32,
			voluntaryContextSwitches: 8845,
			involuntaryContextSwitches: 377,
			time: 1791286877789,
			period: 90002,
			cpuUtilization: 0.01,
			node,
		},
		{
			id: 1791286907788.8682,
			metric: 'resource-usage',
			userCPUTime: 182.5690000001341,
			systemCPUTime: 74.00700000009965,
			minorPageFault: 3,
			majorPageFault: 0,
			fsRead: 0,
			fsWrite: 24,
			voluntaryContextSwitches: 3011,
			involuntaryContextSwitches: 140,
			time: 1791286907788,
			period: 29999,
			cpuUtilization: 0.01,
			node,
		},
	];
	return { node, success, 'resource-usage': resourceUsage };
}

//the endpoint returns {contentType, data} so harper sends plain text instead of json-quoting the string
async function loadBody() {
	const response = await new current_load_for_gtm().get();
	return response.data;
}

// Degraded state is module-level and deliberately persists across polls, so a test that asserts
// warning counts has to start from a known-healthy state rather than whatever ran before it.
async function startHealthy() {
	operationHandler = () => asyncIterable(analyticsRows());
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

	it("sums this node's newest cycle across paths and methods, ignoring other nodes and older cycles", async () => {
		operationHandler = () => asyncIterable(analyticsRows());

		assert.equal(await loadBody(), 'load:200');
	});

	it("returns a plain text body so GTM's leader-string parse sees load:N unquoted", async () => {
		operationHandler = () => asyncIterable(analyticsRows());

		const response = await new current_load_for_gtm().get();
		assert.equal(response.contentType, 'text/plain');
		assert.match(response.data, /^load:\d+$/);
	});

	it('resolves the node from server.hostname, not replication.hostname', async () => {
		// The shape that regressed: node.hostname set, replication.hostname absent.
		server.config = { replication: {} };
		operationHandler = () => asyncIterable(analyticsRows());

		assert.equal(await loadBody(), 'load:200');
		server.config = {};
	});

	it('caps at max when the rate exceeds the target', async () => {
		//90,000 requests over 60s = 1,500 req/s against the default 1,000 target
		operationHandler = () => asyncIterable([successRow('node-a', 200_000, 90_000)]);

		assert.equal(await loadBody(), 'load:1000');
	});

	it('falls back to the aggregation period when the row carries no period', async () => {
		const row = successRow('node-a', 200_000, 12_000);
		delete row.period;
		operationHandler = () => asyncIterable([row]);

		assert.equal(await loadBody(), 'load:200');
	});

	it('bounds both analytics queries at both ends so core can pin the id range', async () => {
		const requests = [];
		operationHandler = (received) => {
			requests.push(received);
			return asyncIterable(analyticsRows());
		};

		await loadBody();

		assert.deepEqual(
			requests.map((request) => request.metric),
			['success', 'resource-usage']
		);
		for (const request of requests) {
			assert.equal(typeof request.end_time, 'number');
			// Default aggregatePeriod of 60s -> a 120s window.
			assert.equal(request.end_time - request.start_time, 120_000);
		}
	});

	it('reports zero load, not max, for an idle node whose analytics are still being written', async () => {
		operationHandler = (request) =>
			request.metric === 'success'
				? asyncIterable([successRow('node-b', 200_002, 999_999)])
				: asyncIterable([resourceUsageRow('node-a', 200_000)]);

		assert.equal(await loadBody(), 'load:0');
		assert.equal(warnings.length, 0);
	});

	it('reports zero load when the newest cycle has no request rows, even if an older in-window cycle does', async () => {
		// The boundary from review: a 60,000-count success row from the previous cycle plus a
		// resource-usage row from the current one. The node is idle now, not at 1,000 req/s.
		operationHandler = (request) =>
			request.metric === 'success'
				? asyncIterable([successRow('node-a', 140_000, 60_000)])
				: asyncIterable([resourceUsageRow('node-a', 200_000)]);

		assert.equal(await loadBody(), 'load:0');
		assert.equal(warnings.length, 0);
	});

	it('keeps reporting the measured rate when the resource-usage row belongs to the same cycle', async () => {
		// Core writes a cycle's resource-usage row in the same tight loop as its success rows, a few
		// milliseconds later, so it must not push those rows out of the cycle.
		operationHandler = (request) =>
			request.metric === 'success'
				? asyncIterable(analyticsRows())
				: asyncIterable([resourceUsageRow('node-a', 200_003)]);

		assert.equal(await loadBody(), 'load:200');
	});

	it('reproduces an idle stage node from captured production rows', async () => {
		// Three aggregation cycles of get_analytics output captured from us-east1-b-1 on the lfct1
		// stage cluster (harper 5.0.2, 2026-10-06), unedited: GTM liveness tests plus load-object
		// polls, 44 requests in the newest cycle, which the node reported live as load:1.
		const captured = capturedStageRows();
		server.hostname = captured.node;
		operationHandler = (request) => asyncIterable(captured[request.metric]);

		assert.equal(await loadBody(), 'load:1');
		server.hostname = 'node-a';
	});

	it('reports max load when this node has no analytics rows at all', async () => {
		operationHandler = () => asyncIterable([successRow('node-b', 200_002, 999_999)]);

		assert.equal(await loadBody(), 'load:1000');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /no analytics rows/);
	});

	it('reports max load when the analytics query fails', async () => {
		operationHandler = () => {
			throw new Error('boom');
		};

		assert.equal(await loadBody(), 'load:1000');
	});

	it('warns once per degraded episode, not once per poll', async () => {
		await startHealthy();
		operationHandler = () => {
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
		operationHandler = () => {
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
		operationHandler = () => {
			throw new Error('boom');
		};
		now += 60_000;
		await loadBody();

		now += 60_000;
		operationHandler = () => asyncIterable(analyticsRows());
		assert.equal(await loadBody(), 'load:200');

		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /recovered/);
	});

	it('shares one analytics scan across concurrent polls', async () => {
		//each scan issues one success query and one resource-usage query, so count scans by the former
		let queries = 0;
		operationHandler = (request) => {
			if (request.metric === 'success') queries++;
			return asyncIterable(analyticsRows());
		};

		const results = await Promise.all(Array.from({ length: 10 }, () => loadBody()));

		assert.equal(queries, 1);
		assert.deepEqual(new Set(results), new Set(['load:200']));
	});

	it('serves the cached value inside the TTL and recomputes after it', async () => {
		let queries = 0;
		operationHandler = (request) => {
			if (request.metric === 'success') queries++;
			return asyncIterable(analyticsRows());
		};

		await loadBody();
		// Past the old fixed 2s TTL but inside the derived one (half of a 60s aggregation period).
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
