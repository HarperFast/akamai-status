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

function utilizationRow(node, id, utilization) {
	return { node, id, utilization, metric: 'utilization' };
}

function analyticsRows() {
	return [utilizationRow('node-b', 3, 0.9), utilizationRow('node-a', 1, 0.1), utilizationRow('node-a', 2, 0.25)];
}

async function* asyncIterable(rows) {
	for (const row of rows) yield row;
}

// Degraded state is module-level and deliberately persists across polls, so a test that asserts
// warning counts has to start from a known-healthy state rather than whatever ran before it.
async function startHealthy() {
	operationHandler = () => asyncIterable(analyticsRows());
	now += 60_000;
	await new current_load_for_gtm().get();
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

	it("scales this node's newest utilization row, ignoring other nodes", async () => {
		operationHandler = () => asyncIterable(analyticsRows());

		assert.equal(await new current_load_for_gtm().get(), 'load:250');
	});

	it('resolves the node from server.hostname, not replication.hostname', async () => {
		// The shape that regressed: node.hostname set, replication.hostname absent.
		server.config = { replication: {} };
		operationHandler = () => asyncIterable(analyticsRows());

		assert.equal(await new current_load_for_gtm().get(), 'load:250');
		server.config = {};
	});

	it('bounds the analytics query at both ends so core can pin the id range', async () => {
		let request;
		operationHandler = (received) => {
			request = received;
			return asyncIterable(analyticsRows());
		};

		await new current_load_for_gtm().get();

		assert.equal(typeof request.end_time, 'number');
		// Default aggregatePeriod of 60s -> a 120s window.
		assert.equal(request.end_time - request.start_time, 120_000);
	});

	it('reports max load when this node has no analytics rows', async () => {
		operationHandler = () => asyncIterable([utilizationRow('node-b', 3, 0.9)]);

		assert.equal(await new current_load_for_gtm().get(), 'load:1000');
	});

	it('reports max load when the analytics query fails', async () => {
		operationHandler = () => {
			throw new Error('boom');
		};

		assert.equal(await new current_load_for_gtm().get(), 'load:1000');
	});

	it('warns once per degraded episode, not once per poll', async () => {
		await startHealthy();
		operationHandler = () => {
			throw new Error('boom');
		};

		for (let poll = 0; poll < 5; poll++) {
			now += 60_000;
			await new current_load_for_gtm().get();
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
			await new current_load_for_gtm().get();
		}

		assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}: ${warnings.join(' | ')}`);
	});

	it('warns again on recovery so the degraded state has a visible end', async () => {
		await startHealthy();
		operationHandler = () => {
			throw new Error('boom');
		};
		now += 60_000;
		await new current_load_for_gtm().get();

		now += 60_000;
		operationHandler = () => asyncIterable(analyticsRows());
		assert.equal(await new current_load_for_gtm().get(), 'load:250');

		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /recovered/);
	});

	it('shares one analytics query across concurrent polls', async () => {
		let queries = 0;
		operationHandler = () => {
			queries++;
			return asyncIterable(analyticsRows());
		};

		const results = await Promise.all(Array.from({ length: 10 }, () => new current_load_for_gtm().get()));

		assert.equal(queries, 1);
		assert.deepEqual(new Set(results), new Set(['load:250']));
	});

	it('serves the cached value inside the TTL and recomputes after it', async () => {
		let queries = 0;
		operationHandler = () => {
			queries++;
			return asyncIterable(analyticsRows());
		};

		await new current_load_for_gtm().get();
		// Past the old fixed 2s TTL but inside the derived one (half of a 60s aggregation period).
		now += 20_000;
		await new current_load_for_gtm().get();
		assert.equal(queries, 1);

		now += 20_000;
		await new current_load_for_gtm().get();
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
