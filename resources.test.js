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

	it('bounds the analytics query at both ends so core can pin the id range', async () => {
		let request;
		operationHandler = (received) => {
			request = received;
			return asyncIterable(analyticsRows());
		};

		await loadBody();

		assert.equal(request.metric, 'success');
		assert.equal(typeof request.end_time, 'number');
		// Default aggregatePeriod of 60s -> a 120s window.
		assert.equal(request.end_time - request.start_time, 120_000);
	});

	it('reports zero load, not max, for an idle node whose analytics are still being written', async () => {
		operationHandler = (request) =>
			request.metric === 'success'
				? asyncIterable([successRow('node-b', 200_002, 999_999)])
				: asyncIterable([resourceUsageRow('node-a', 200_000)]);

		assert.equal(await loadBody(), 'load:0');
		assert.equal(warnings.length, 0);
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

	it('shares one analytics query across concurrent polls', async () => {
		let queries = 0;
		operationHandler = () => {
			queries++;
			return asyncIterable(analyticsRows());
		};

		const results = await Promise.all(Array.from({ length: 10 }, () => loadBody()));

		assert.equal(queries, 1);
		assert.deepEqual(new Set(results), new Set(['load:200']));
	});

	it('serves the cached value inside the TTL and recomputes after it', async () => {
		let queries = 0;
		operationHandler = () => {
			queries++;
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
