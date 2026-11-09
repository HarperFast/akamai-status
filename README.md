# @harperfast/akamai-status

This component provides endpoints for Akamai services to determine Harper instance health, status, and load for traffic routing.

## Endpoints

| Endpoint                             | Method        | Description                           |
| ------------------------------------ | ------------- | ------------------------------------- |
| `/status`                            | GET           | Health check for Akamai routing       |
| `/status`                            | POST / DELETE | Set this node Available / Unavailable |
| `/current_load_for_gtm`              | GET           | Load feedback for Akamai GTM          |
| `/akamai/sureroute-test-object.html` | GET           | Static HTML for SureRoute testing     |

Both resources set `static hidden = true`, so on Harper 5.1+ they are left out of MCP tools and resources
and the OpenAPI document. They are infrastructure routes for GTM; without this, an MCP client signed in as
a `super_user` would see `delete_status` as a tool it can call. REST serves them as usual.

This component supersedes [`status-check-fabric`](https://github.com/HarperFast/status-check-fabric) and
[`akamai-sureroute-test-object`](https://github.com/HarperFast/akamai-sureroute-test-object), which it is a
drop-in superset of.

## Usage

### GET /status

Returns the current operational status of the Harper instance.

- Returns HTTP `200` when status is "Available"
- Returns HTTP `404` otherwise

```shell
curl http://localhost:9926/status
# "Status endpoint is reporting for duty."
```

### POST /status, DELETE /status

Sets this node Available (`POST`) or Unavailable (`DELETE`). Both require a `super_user` — they inherit
Harper's default `allowCreate`/`allowDelete`, so a role granted only the `set_status` _operation_ can use
the operations API below but not these routes. An unauthenticated request is rejected with `401`.

```shell
curl -X DELETE http://localhost:9926/status --header "Authorization: Basic $AUTH"
```

Status can equivalently be set through the operations API or the CLI:

```shell
curl -X POST http://localhost:9925 \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $AUTH" \
  -d '{"operation": "set_status", "id": "availability", "status": "Unavailable"}'

harper set_status id=availability status=Unavailable
```

### GET /current_load_for_gtm

Returns server load for Akamai GTM: how busy this node's HTTP worker threads are.

```shell
curl http://localhost:9926/current_load_for_gtm
# load:39
```

The body is `load:N`, served as `text/plain` and unquoted, so GTM's `load:` leader-string parse works on
the raw bytes. `N` is the share of the last window that this node's HTTP workers spent running on their
event loops, averaged over the workers, times `scale`. With the default `scale` of 1000, `load:1000` means
every worker was busy for the whole window. That is the ceiling: a worker cannot be more than fully busy.
An idle node reads close to `load:0`.

The figure is built from the event-loop utilization core attaches to every HTTP worker's raw analytics
report: the milliseconds the worker's event loop was active and idle since its previous report. Each worker
flushes a report about once a second while it serves requests, into `system.hdb_raw_analytics`, a table
core keeps per node and never replicates. The component sums the active time that falls inside the last
window across every worker's reports, and divides by the window times the worker count; a worker that
wrote no report in the window recorded no activity and counts as idle. The window is one analytics
aggregation period by default (`analytics.aggregatePeriod`, 60s). Reading the raw reports keeps the scan
bounded by this node's workers rather than by the cluster, and moves the value every second rather than
once per aggregation cycle.

Utilization counts everything a worker's event loop runs, not only the requests GTM steers, so background
work on the workers raises it too and makes GTM shift traffic away. Akamai's load feedback guidance asks for
a value that changes only with the traffic GTM sends; this component departs from that on purpose, for a
measure with an objective ceiling. Utilization does not see time a request spends waiting on storage or an
origin, because the event loop is idle while it waits, nor work on the main thread, which serves the
operations API, or on native threads. Other worker threads, such as import and export jobs, report
utilization too, and their busy time counts against the HTTP workers' time, so a long job can raise the
reading. A single saturated worker among idle ones shows only as its share of the average.

harper-pro's profiler inflates utilization while it samples, to about 0.7 on an idle worker. From
harper-pro 5.4 ([HarperFast/harper-pro#1012](https://github.com/HarperFast/harper-pro/pull/1012)) it
samples only in short windows and flags each report that overlapped one with a `profiler-sampling` entry;
the component leaves flagged reports out of both the busy time and the time it divides by. On an older
harper-pro, set `analytics.profiling: false`, or an idle node reads about 700.

The component counts only reports written since it loaded, so a restarted node does not read its previous
run. Until it has measured at least one worker's window, the endpoint reports `max`: about 30 s after a
start on a two-worker node, and about two and a half minutes on harper-pro, whose profiler samples for the
first two aggregation periods. Sampling leaves too little measured again for a moment once every thousand
periods.

GTM balances datacenters, not nodes. The GTM resource aggregates its datacenter's load servers (median on
Fabric), so with several nodes in one datacenter GTM sees one number for all of them and cannot shed from
one node alone. Nodes in one datacenter should be the same size.

Core writes a report only for a worker that recorded something in that second, and GTM's own liveness and
load polls are requests, so a window with no reports at all means analytics are not being written: the
endpoint reports `max`, which takes the node out of GTM rotation. The same happens when the raw analytics
query fails, or when no report in the window carries utilization: core attaches it only to HTTP worker
reports, so a single-threaded node, which serves HTTP on its main thread, has none. Entering and leaving
this state is logged at `warn`, once per episode rather than once per poll.

Load is not a health signal. A node whose application is gone answers with cheap 404s, and handlers that
fail fast take little time, so such a node reads as nearly idle, and GTM steers traffic to it while
`/status` still passes. Take a broken node out of rotation with `DELETE /status`.

Each worker caches its value for half the window (30s by default), GTM's poll interval. A refresh decodes
every report in the window; measured on a two-worker laptop at 200 active endpoints and 5,700 requests per
second, that is 14 MB of reports and about 25 ms.

### GET /akamai/sureroute-test-object.html

Static HTML content for Akamai SureRoute testing.

```shell
curl http://localhost:9926/akamai/sureroute-test-object.html
```

## Configuration

Optional configuration in `harperdb-config.yaml`:

```yaml
akamaiStatus:
  loadThresholds:
    scale: 1000 # Load reported when every worker's event loop is busy the whole window (default: 1000)
    max: 1000 # Reported when load cannot be measured, and the clamp on any reading (default: scale)
    windowSeconds: 60 # Span of raw reports averaged per poll (default: analytics.aggregatePeriod)
```

`windowSeconds` is clamped to at most what core retains, `analytics.rawRetentionMs` (1 hour by default,
never less than one aggregation period), so the window never divides by time core has already cleaned up,
and to at least 30s, GTM's poll interval, so an idle node always has a report in the window. When core
retains less than 30s, because `analytics.aggregatePeriod` is itself shorter, the floor follows the retained
span, and a node that receives nothing but GTM's polls reads `max` on every poll that finds no report in
the window. A clamped value is logged once at load.

`scale` only sets the resolution of the number; GTM compares datacenters relative to each other. `max` is
what a node reports when its load cannot be measured, so GTM shifts traffic away from it; by default it
equals `scale`, the reading of a fully busy node, so it is the same value 1.0.0 reported. The GTM resource's
upper bound must be 0 (no check) or at least `max`, or GTM rejects the fail-safe value as invalid.

**Examples:**

Default, two workers, each event loop busy 8% of the window → `load:80`

Saturated node, every worker's event loop busy the whole window → `load:1000`

Analytics not being written → `load:1000`

## Releasing

Releases are cut automatically from `main` by [semantic-release](https://semantic-release.gitbook.io/), which
reads [Conventional Commits](https://www.conventionalcommits.org/) to pick the next version: `feat` is a minor,
a `!` or `BREAKING CHANGE:` footer is a major, and every other type is a patch. It tags the release, writes
the GitHub release notes, and commits the version back to `main`; a separate job then publishes the tag to npm
through trusted publishing, with provenance.

That job publishes the newest release tag whenever npm doesn't have its version. If a publish fails, re-run the
Release workflow, or run it manually on `main`, before anything else merges: once a newer version is released,
the failed one stays unpublished.

semantic-release reads the squash commit. With this repo's merge settings, its title is the PR title, or the
commit's own title for a single-commit PR, and its body holds every commit's full message: a `BREAKING CHANGE:`
footer in any of them makes a major, and the release notes keep everything after that footer. Trim the body when
merging. Commit messages and PR titles are checked with commitlint; to check one locally:
`echo "fix: handle empty window" | npx commitlint`.
