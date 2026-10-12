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
	workerCount: 2,
	config: {},
	operation: (request) => operationHandler(request),
};

const { status, current_load_for_gtm } = await import('./resources.js');

// Core stamps every duration row of a cycle with one time; here that is the id's whole second.
function durationRow(node, id, count, mean, path = '/resource', method = 'GET') {
	const time = Math.floor(id / 1000) * 1000;
	return { node, id, time, count, mean, path, method, metric: 'duration', period: 60_000 };
}

function resourceUsageRow(node, id) {
	return { node, id, metric: 'resource-usage', period: 60_000 };
}

function analyticsRows() {
	return [
		durationRow('node-b', 200_002, 999_999, 50),
		durationRow('node-a', 140_000, 60_000, 10),
		durationRow('node-a', 200_000, 9_000, 2, '/resource', 'GET'),
		durationRow('node-a', 200_001, 3_000, 10, '/resource', 'POST'),
	];
}

async function* asyncIterable(rows) {
	for (const row of rows) yield row;
}

function forMetrics(rowsByMetric) {
	return (request) => asyncIterable(rowsByMetric[request.metric] ?? []);
}

// Verbatim get_analytics rows from a stage node.
function capturedStageRows() {
	const node = 'q1r-us-east1-b-1.lfct1.devin-enterprise.stage.harperfabric.com';
	// four idle cycles on 2026-10-07: GTM liveness tests and load-object polls only, which the node reported live as load:0
	const idle = {
		'duration': [
			{
				id: 1791391219387.947,
				period: 60000,
				metric: 'duration',
				path: 'status',
				method: 'GET',
				mean: 0.4269575700163841,
				count: 40,
				p1: 0.3193029099702835,
				p10: 0.3693938910961151,
				p25: 0.3898874968290329,
				median: 0.4257644712924957,
				p75: 0.45727749168872833,
				p90: 0.492206996679306,
				p95: 0.5202110141515731,
				p99: 0.5407690024375915,
				p999: 0.5414358875751495,
				time: 1791391187799.3955,
				node,
			},
			{
				id: 1791391219390.3506,
				period: 60000,
				metric: 'duration',
				path: 'current_load_for_gtm',
				method: 'GET',
				mean: 1.8729306658109028,
				count: 6,
				p1: 0.20100403130054473,
				p10: 0.20896002650260925,
				p25: 0.7037472426891327,
				median: 2.2606289386749268,
				p75: 2.7940232157707214,
				p90: 3.1492029428482056,
				p95: 3.2544004321098328,
				p99: 3.338558423519135,
				p999: 3.3574939715862273,
				time: 1791391187799.3955,
				node,
			},
			{
				id: 1791391249387.521,
				period: 60000,
				metric: 'duration',
				path: 'status',
				method: 'GET',
				mean: 0.42336775326147313,
				count: 41,
				p1: 0.2959693670272827,
				p10: 0.3678390383720398,
				p25: 0.3836299777030945,
				median: 0.40508997440338135,
				p75: 0.44645899534225464,
				p90: 0.48951995372772217,
				p95: 0.5323300361633301,
				p99: 0.6678633689880373,
				p999: 0.7337574124336245,
				time: 1791391248282.2295,
				node,
			},
			{
				id: 1791391249389.285,
				period: 60000,
				metric: 'duration',
				path: 'current_load_for_gtm',
				method: 'GET',
				mean: 1.3769528031349183,
				count: 5,
				p1: 0.19706666946411133,
				p10: 0.20388542413711547,
				p25: 0.21525001525878906,
				median: 0.24518901109695435,
				p75: 2.9326279163360596,
				p90: 3.15028395652771,
				p95: 3.2228359699249265,
				p99: 3.2808775806427,
				p999: 3.293936943054199,
				time: 1791391248282.2295,
				node,
			},
			{
				id: 1791391339388.8733,
				period: 60000,
				metric: 'duration',
				path: 'status',
				method: 'GET',
				mean: 0.45884797631240454,
				count: 41,
				p1: 0.34848560094833375,
				p10: 0.361549973487854,
				p25: 0.374239981174469,
				median: 0.41179001331329346,
				p75: 0.4396989941596985,
				p90: 0.4761189818382263,
				p95: 0.5054900050163269,
				p99: 1.5845747232437155,
				p999: 2.16529355287552,
				time: 1791391310153.8318,
				node,
			},
			{
				id: 1791391339391.226,
				period: 60000,
				metric: 'duration',
				path: 'current_load_for_gtm',
				method: 'GET',
				mean: 2.3910174667835236,
				count: 4,
				p1: 0.40884039342403433,
				p10: 1.0754833757877351,
				p25: 2.1865550130605698,
				median: 2.8688820600509644,
				p75: 3.073344588279724,
				p90: 3.3242600917816163,
				p95: 3.4078985929489134,
				p99: 3.4748093938827513,
				p999: 3.489864324092865,
				time: 1791391310153.8318,
				node,
			},
			{
				id: 1791391369389.635,
				period: 60000,
				metric: 'duration',
				path: 'status',
				method: 'GET',
				mean: 0.5074192946021622,
				count: 37,
				p1: 0.3614140319824219,
				p10: 0.3768939971923828,
				p25: 0.3992599844932556,
				median: 0.4281800389289856,
				p75: 0.4713600277900696,
				p90: 0.5574055910110474,
				p95: 0.5942772030830379,
				p99: 2.0682030987739575,
				p999: 2.7736994869708984,
				time: 1791391368433.7126,
				node,
			},
			{
				id: 1791391369392.116,
				period: 60000,
				metric: 'duration',
				path: 'current_load_for_gtm',
				method: 'GET',
				mean: 3.2334980368614197,
				count: 2,
				p1: 3.071592288017273,
				p10: 3.1013300895690916,
				p25: 3.1508930921554565,
				median: 3.2334980964660645,
				p75: 3.3161031007766724,
				p90: 3.3656661033630373,
				p95: 3.382187104225159,
				p99: 3.395403904914856,
				p999: 3.398377685070038,
				time: 1791391368433.7126,
				node,
			},
		],
		'resource-usage': [
			{
				id: 1791391219391.731,
				metric: 'resource-usage',
				userCPUTime: 573.8969999998808,
				systemCPUTime: 230.7589999998454,
				minorPageFault: 1,
				majorPageFault: 0,
				fsRead: 0,
				fsWrite: 24,
				voluntaryContextSwitches: 8783,
				involuntaryContextSwitches: 474,
				time: 1791391219391,
				period: 90004,
				cpuUtilization: 0.01,
				node,
			},
			{
				id: 1791391249390.6467,
				metric: 'resource-usage',
				userCPUTime: 218.3859999999404,
				systemCPUTime: 79.3519999999553,
				minorPageFault: 3,
				majorPageFault: 0,
				fsRead: 0,
				fsWrite: 32,
				voluntaryContextSwitches: 2950,
				involuntaryContextSwitches: 188,
				time: 1791391249390,
				period: 29999,
				cpuUtilization: 0.01,
				node,
			},
			{
				id: 1791391339392.6636,
				metric: 'resource-usage',
				userCPUTime: 582.5440000002272,
				systemCPUTime: 232.14500000001863,
				minorPageFault: 2,
				majorPageFault: 0,
				fsRead: 0,
				fsWrite: 24,
				voluntaryContextSwitches: 8779,
				involuntaryContextSwitches: 512,
				time: 1791391339393,
				period: 90003,
				cpuUtilization: 0.01,
				node,
			},
			{
				id: 1791391369392.9304,
				metric: 'resource-usage',
				userCPUTime: 203.54900000011548,
				systemCPUTime: 100.99400000018068,
				minorPageFault: 1,
				majorPageFault: 0,
				fsRead: 0,
				fsWrite: 24,
				voluntaryContextSwitches: 3037,
				involuntaryContextSwitches: 396,
				time: 1791391369393,
				period: 30000,
				cpuUtilization: 0.01,
				node,
			},
		],
	};
	// one cycle from the 2026-10-05 flood of the GTM hostname at ~130 req/s, which reads 79 per node and 39 per worker on that two-worker node
	const flood = {
		'duration': [
			{
				id: 1791217396692.2407,
				period: 60000,
				metric: 'duration',
				path: 'status',
				method: 'GET',
				mean: 0.5240897167267562,
				count: 8787,
				p1: 0.23008714165006366,
				p10: 0.2939583361148834,
				p25: 0.37737049839713355,
				median: 0.4986226558685303,
				p75: 0.627747730775313,
				p90: 0.8763850361108783,
				p95: 1.2838706572850538,
				p99: 2.7153404998779282,
				p999: 5.417502018928527,
				time: 1791217366860.3525,
				node,
			},
			{
				id: 1791217396698.6653,
				period: 60000,
				metric: 'duration',
				path: 'current_load_for_gtm',
				method: 'GET',
				mean: 11.776681488752365,
				count: 10,
				p1: 0.17391448557376862,
				p10: 0.3180450737476349,
				p25: 0.3573617488145828,
				median: 0.5902844965457916,
				p75: 14.964812994003296,
				p90: 31.05638618469237,
				p95: 44.631304359436,
				p99: 55.491238899230964,
				p999: 57.9347241706848,
				time: 1791217366860.3525,
				node,
			},
		],
		'resource-usage': [
			{
				id: 1791217396705.0898,
				metric: 'resource-usage',
				userCPUTime: 30071.139999999898,
				systemCPUTime: 6208.3739999999525,
				minorPageFault: 7786,
				majorPageFault: 0,
				fsRead: 0,
				fsWrite: 40,
				voluntaryContextSwitches: 29720,
				involuntaryContextSwitches: 55790,
				time: 1791217396704,
				period: 89983,
				cpuUtilization: 0.4,
				node,
			},
		],
	};
	return { node, idle, flood };
}

async function loadBody() {
	const response = await new current_load_for_gtm().get();
	return response.data;
}

// Degraded state is module-level and deliberately persists across polls, so a test that asserts
// warning counts has to start from a known-healthy state rather than whatever ran before it.
async function startHealthy() {
	operationHandler = forMetrics({ duration: analyticsRows() });
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

	it("sums handler time over this node's newest cycle across paths and methods, ignoring other nodes and older cycles", async () => {
		operationHandler = forMetrics({ duration: analyticsRows() });

		assert.equal(await loadBody(), 'load:400');
	});

	it("returns a plain text body so GTM's leader-string parse sees load:N unquoted", async () => {
		operationHandler = forMetrics({ duration: analyticsRows() });

		const response = await new current_load_for_gtm().get();
		assert.equal(response.contentType, 'text/plain');
		assert.match(response.data, /^load:\d+$/);
	});

	it('resolves the node from server.hostname, not replication.hostname', async () => {
		// The shape that regressed: node.hostname set, replication.hostname absent.
		server.config = { replication: {} };
		operationHandler = forMetrics({ duration: analyticsRows() });

		assert.equal(await loadBody(), 'load:400');
		server.config = {};
	});

	it('reports more than scale when every worker is more than continuously busy, and only max clamps it', async () => {
		operationHandler = forMetrics({ duration: [durationRow('node-a', 200_000, 180_000, 1)] });
		assert.equal(await loadBody(), 'load:1500');

		now += 60_000;
		operationHandler = forMetrics({ duration: [durationRow('node-a', 200_000, 240_000, 100)] });
		assert.equal(await loadBody(), 'load:100000');
	});

	it('weights requests by handler time, so an expensive request counts for more than a cheap one', async () => {
		operationHandler = forMetrics({
			duration: [
				durationRow('node-a', 200_000, 1_000, 1, '/cached'),
				durationRow('node-a', 200_001, 1_000, 50, '/query'),
			],
		});

		assert.equal(await loadBody(), 'load:425');
	});

	it('falls back to the aggregation period when the row carries no period', async () => {
		const row = durationRow('node-a', 200_000, 9_000, 2);
		const second = durationRow('node-a', 200_001, 3_000, 10, '/resource', 'POST');
		delete row.period;
		delete second.period;
		operationHandler = forMetrics({ duration: [row, second] });

		assert.equal(await loadBody(), 'load:400');
	});

	it('bounds both analytics queries at both ends so core can pin the id range', async () => {
		const requests = [];
		operationHandler = (received) => {
			requests.push(received);
			return asyncIterable(received.metric === 'duration' ? analyticsRows() : []);
		};

		await loadBody();

		assert.deepEqual(
			requests.map((request) => request.metric),
			['duration', 'resource-usage']
		);
		for (const request of requests) {
			assert.equal(typeof request.end_time, 'number');
			// Default aggregatePeriod of 60s -> a 120s window.
			assert.equal(request.end_time - request.start_time, 120_000);
		}
	});

	it('reports zero load, not max, for an idle node whose analytics are still being written', async () => {
		operationHandler = forMetrics({
			'duration': [durationRow('node-b', 200_002, 999_999, 50)],
			'resource-usage': [resourceUsageRow('node-a', 200_000)],
		});

		assert.equal(await loadBody(), 'load:0');
		assert.equal(warnings.length, 0);
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
		operationHandler = forMetrics({ duration: analyticsRows() });

		assert.equal((await new fourWorkers().get()).data, 'load:200');
		assert.equal((await new oneWorker().get()).data, 'load:800');
	});

	it('reports max load, not idle, when a duration row lacks a numeric count or mean', async () => {
		// A changed row contract must fail closed: load:0 would attract traffic to a node whose load is unknown.
		const row = durationRow('node-a', 200_000, 9_000, 2);
		delete row.mean;
		operationHandler = forMetrics({ duration: [row] });
		assert.equal(await loadBody(), 'load:100000');
		assert.match(warnings.at(-1), /no mean/);

		// null is not a mean either, and Number(null) is 0, so it must not slip through as idle.
		now += 60_000;
		operationHandler = forMetrics({ duration: [{ ...durationRow('node-a', 200_000, 9_000, 2), mean: null }] });
		assert.equal(await loadBody(), 'load:100000');

		// A row without a numeric count is the same changed contract. Recover first so the warning is a fresh episode.
		await startHealthy();
		now += 60_000;
		const noCount = durationRow('node-a', 200_000, 9_000, 2);
		delete noCount.count;
		operationHandler = forMetrics({ duration: [noCount] });
		assert.equal(await loadBody(), 'load:100000');
		assert.match(warnings.at(-1), /no count/);
		// Leave the module healthy so the next test's warning count starts from zero.
		await startHealthy();
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

	it('falls back to safe defaults when threshold or period config is not a finite positive number', async () => {
		// CONFIG is built at import time, so load a second module instance under the bad config.
		server.config = {
			analytics: { aggregatePeriod: 'soon' },
			akamaiStatus: { loadThresholds: { scale: 'abc', max: -5 } },
		};
		const { current_load_for_gtm: misconfigured } = await import('./resources.js?config=invalid');
		server.config = {};
		operationHandler = forMetrics({ duration: analyticsRows() });

		const response = await new misconfigured().get();
		// Defaults for scale and max: 0.4 per worker -> load:400, never load:NaN or load:Infinity.
		assert.equal(response.data, 'load:400');
	});

	it('reports zero load when the newest cycle has no request rows, even if an older in-window cycle does', async () => {
		// A busy duration row from the previous cycle, that cycle's resource-usage row, and the
		// current cycle's resource-usage row with no requests: the node is idle now, not at 5 per worker.
		operationHandler = forMetrics({
			'duration': [durationRow('node-a', 140_000, 60_000, 10)],
			'resource-usage': [resourceUsageRow('node-a', 140_003), resourceUsageRow('node-a', 200_000)],
		});

		assert.equal(await loadBody(), 'load:0');
		assert.equal(warnings.length, 0);
	});

	it('keeps reporting the measured rate when the resource-usage row belongs to the same cycle', async () => {
		// Core writes a cycle's resource-usage row in the same tight loop as its duration rows, a few
		// milliseconds later, so it must not push those rows out of the cycle.
		operationHandler = forMetrics({
			'duration': analyticsRows(),
			'resource-usage': [resourceUsageRow('node-a', 200_003)],
		});

		assert.equal(await loadBody(), 'load:400');
	});

	it('keeps the cycle together when core wrote its resource-usage row seconds after the duration rows', async () => {
		// Core awaits a threadpool round trip between a cycle's duration rows and its resource-usage
		// row, and on a saturated node that wait can pass 5 s. The late row must not date a new, empty
		// cycle, or the node would report idle at the moment it is overloaded.
		operationHandler = forMetrics({
			'duration': analyticsRows(),
			'resource-usage': [resourceUsageRow('node-a', 206_000)],
		});

		assert.equal(await loadBody(), 'load:400');
	});

	it('sums only the newest cycle when a slow cycle and the next one were written moments apart', async () => {
		// While core catches up, a cycle that took most of a period and the next one can be written
		// within seconds of each other. Only the newest cycle is this node's load.
		operationHandler = forMetrics({
			'duration': [
				durationRow('node-a', 199_990, 60_000, 10, '/resource', 'GET'),
				durationRow('node-a', 199_991, 60_000, 10, '/resource', 'POST'),
				...analyticsRows(),
			],
			'resource-usage': [resourceUsageRow('node-a', 199_992), resourceUsageRow('node-a', 200_003)],
		});

		assert.equal(await loadBody(), 'load:400');
	});

	it('reports zero load once a later cycle has written its resource-usage row and no request rows', async () => {
		operationHandler = forMetrics({
			'duration': analyticsRows(),
			'resource-usage': [resourceUsageRow('node-a', 200_003), resourceUsageRow('node-a', 230_000)],
		});

		assert.equal(await loadBody(), 'load:0');
	});

	it('reports max load, not idle, when a duration row carries no cycle time', async () => {
		const row = durationRow('node-a', 200_000, 9_000, 2);
		delete row.time;
		operationHandler = forMetrics({ duration: [row] });

		assert.equal(await loadBody(), 'load:100000');
		assert.match(warnings.at(-1), /no time/);
	});

	it('reproduces an idle stage node from captured production rows', async () => {
		const captured = capturedStageRows();
		server.hostname = captured.node;
		operationHandler = (request) => asyncIterable(captured.idle[request.metric] ?? []);

		assert.equal(await loadBody(), 'load:0');
		server.hostname = 'node-a';
	});

	it('reproduces a flooded stage node from captured production rows', async () => {
		// 8,787 liveness-path responses at 0.52ms plus 10 load polls at 11.8ms = 4,723ms over 60s on two workers.
		const captured = capturedStageRows();
		server.hostname = captured.node;
		operationHandler = (request) => asyncIterable(captured.flood[request.metric] ?? []);

		assert.equal(await loadBody(), 'load:39');
		server.hostname = 'node-a';
	});

	it('reports max load when this node has no analytics rows at all', async () => {
		operationHandler = forMetrics({ duration: [durationRow('node-b', 200_002, 999_999, 50)] });

		assert.equal(await loadBody(), 'load:100000');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /no analytics rows/);
	});

	it('reports max load when the analytics query fails', async () => {
		operationHandler = () => {
			throw new Error('boom');
		};

		assert.equal(await loadBody(), 'load:100000');
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
		operationHandler = forMetrics({ duration: analyticsRows() });
		assert.equal(await loadBody(), 'load:400');

		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /recovered/);
	});

	it('shares one analytics scan across concurrent polls', async () => {
		// each scan issues a duration query and a resource-usage query, so count scans by the former
		let queries = 0;
		operationHandler = (request) => {
			if (request.metric === 'duration') queries++;
			return asyncIterable(request.metric === 'duration' ? analyticsRows() : []);
		};

		const results = await Promise.all(Array.from({ length: 10 }, () => loadBody()));

		assert.equal(queries, 1);
		assert.deepEqual(new Set(results), new Set(['load:400']));
	});

	it('serves the cached value inside the TTL and recomputes after it', async () => {
		let queries = 0;
		operationHandler = (request) => {
			if (request.metric === 'duration') queries++;
			return asyncIterable(request.metric === 'duration' ? analyticsRows() : []);
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
