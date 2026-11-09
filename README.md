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

## Installation

Add the component at the root of `harper-config.yaml`:

```yaml
'@harperfast/akamai-status':
  package: '@harperfast/akamai-status'
```

or deploy it to a running node, adding `replicated=true` to deploy it to every node in the cluster:

```shell
harper deploy_component project=akamai-status package=@harperfast/akamai-status restart=true
```

## Usage

### GET /status

Returns the current operational status of the Harper instance.

- Returns HTTP `200` when status is "Available"
- Returns HTTP `404` otherwise

```shell
curl http://localhost:9926/status
# "Status endpoint is reporting for duty."
```

This is the endpoint for GTM's liveness test. GTM takes a node out of rotation only when it fails this
test or its datacenter is disabled; the load below only shifts traffic between datacenters.

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

#### How the load is computed

The figure is built from the event-loop utilization core attaches to every HTTP worker's raw analytics
report: the milliseconds the worker's event loop was active and idle since its previous report. Each worker
flushes a report about once a second while it serves requests, into `system.hdb_raw_analytics`, a table
core keeps per node and never replicates. The window is one analytics aggregation period by default
(`analytics.aggregatePeriod`, 60s). Reading the raw reports keeps the scan bounded by this node's workers
rather than by the cluster, and moves the value every second rather than once per aggregation cycle.

For a poll at time $`t`$, let $`W`$ be the window, $`n`$ the number of HTTP workers, and $`t_0`$ the time the
component loaded. It counts only reports written since it loaded, so a restarted node does not read its
previous run, and the counted span starts at

```math
s = \max(t - W,\ t_0)
```

Each report $`r`$ written since $`s`$ is stamped $`\tau_r`$ and carries its worker's active time $`a_r`$
and idle time $`i_r`$ since that worker's previous report. That span can start before $`s`$, so only the
part inside the counted span, $`u_r`$, counts, and the report's active time is prorated to it. Reports
flagged `profiler-sampling` (the set $`F`$, see below) count as neither busy nor measured:

```math
u_r = \min(a_r + i_r,\ \tau_r - s), \qquad
B = \sum_{r \notin F} a_r \, \frac{u_r}{a_r + i_r}, \qquad
S = \sum_{r \in F} u_r
```

$`B`$ is the busy time. The time it is divided by is the span times the number of workers, less the
sampled time:

```math
M = n\,(t - s) - S
```

A worker that wrote no report in the span recorded no activity: it adds nothing to $`B`$ and its time
stays in $`M`$, so it counts as idle. The endpoint then reports

```math
N = \begin{cases}
\min\!\left(\operatorname{round}\!\left(\mathit{scale} \cdot \dfrac{B}{M}\right),\ \mathit{max}\right) & \text{if } M \ge W \\[1.5ex]
\mathit{max} & \text{if } M < W
\end{cases}
```

On a two-worker node with the default 60s window, $`M`$ is 120 s once the node has run a full window; if
each event loop was busy 4.8 s of it, $`B/M = 9.6/120 = 0.08`$ and the endpoint reads `load:80`.

#### When it reports max

The endpoint reports `max` instead of a measurement when:

- less than one window of worker time has been measured ($`M < W`$), right after a start or while
  harper-pro's profiler samples;
- no report at all was written in the window. Core writes a report only for a worker that recorded
  something in that second, and GTM's own liveness and load polls are requests, so this means analytics
  are not being written;
- no report in the window carries utilization. Core attaches it only to HTTP worker reports, so a
  single-threaded node, which serves HTTP on its main thread, has none;
- the raw analytics query fails, or a report's utilization lacks a numeric active or idle time.

Entering and leaving this state is logged at `warn`, once per episode rather than once per poll.

$`M`$ grows by $`n`$ seconds every second, so after a start the endpoint measures once
$`t - t_0 \ge W/n`$: 30 s on a two-worker node with the default window.

harper-pro's profiler inflates utilization while it samples, to about 0.7 on an idle worker. From
harper-pro 5.4 ([HarperFast/harper-pro#1012](https://github.com/HarperFast/harper-pro/pull/1012)) it
samples only in windows of one aggregation period $`p`$, and flags each report that overlapped one with a
`profiler-sampling` entry, which is what leaves those reports out of $`B`$ and $`M`$ above. On an older
harper-pro, set `analytics.profiling: false`, or an idle node reads about 700.

harper-pro samples through its first two aggregation periods, so on harper-pro the endpoint measures once

```math
t - t_0 \ge 2p + \frac{W}{n}
```

With the default 60s period and window, that is two and a half minutes on two workers and three minutes
on one. A poll can serve a value cached up to $`W/2`$ earlier, so the first measured reading can arrive up
to 30 s later; a one-worker node on Fabric stage read `max` for 3 to 3½ minutes after each restart. After
that the profiler samples one period about every thousand periods (about 17 hours at the default period),
on all workers at about the same time. With the default window of one period, the node reads `max` again
for about $`2W/n`$: two minutes on one worker, one minute on two.

#### What utilization sees

Utilization counts everything a worker's event loop runs, not only the requests GTM steers, so background
work on the workers raises it too and makes GTM shift traffic away. Akamai's load feedback guidance asks for
a value that changes only with the traffic GTM sends; this component departs from that on purpose, for a
measure with an objective ceiling. Utilization does not see time a request spends waiting on storage or an
origin, because the event loop is idle while it waits, nor work on the main thread, which serves the
operations API, or on native threads. Other worker threads, such as import and export jobs, report
utilization too, and their busy time counts against the HTTP workers' time, so a long job can raise the
reading. A single saturated worker among idle ones shows only as its share of the average.

#### How GTM uses it

GTM balances datacenters, not nodes. The GTM resource aggregates its datacenter's load servers (median on
Fabric), so with several nodes in one datacenter GTM sees one number for all of them and cannot shed from
one node alone. Nodes in one datacenter should be the same size.

GTM gives each datacenter $`d`$ a target from the loads it reads
([Akamai: traffic targets](https://techdocs.akamai.com/gtm/docs/traffic-tgt)): it sums the loads across
the property's datacenters, multiplies the sum by the property's load imbalance factor $`f`$, and splits
the result by the datacenters' normalized weights $`w`$:

```math
\mathrm{target}_d = f \cdot \sum_k N_k \cdot \frac{w_d}{\sum_k w_k}
```

GTM moves traffic away from a datacenter whose load is above its target. Reporting `max` therefore sheds
traffic only relative to the other datacenters, and never marks one down: only a failing liveness test or
disabling the datacenter does that. With equal weights and every datacenter at `max`, each target is
$`f \cdot \mathit{max} \ge \mathit{max}`$, so none is over its target and traffic stays where it is. On a
two-datacenter Fabric stage cluster, both nodes reading `max` for 30 minutes left GTM's answers unchanged.
Shifting is gradual: with one node flooded to 70–110 and the other at 3–5, GTM began sending some resolvers
to the idle node after about 22 minutes, a few resolvers at a time.

Load is not a health signal. A node whose application is gone answers with cheap 404s, and handlers that
fail fast take little time, so such a node reads as nearly idle. GTM expects a datacenter's load to rise
as it sends traffic there and keeps sending while it does not, so it steers traffic to the broken node
while `/status` still passes. Take a broken node out of rotation with `DELETE /status`.

#### Cost

Each worker caches its value for half the window (30s by default), GTM's poll interval. A refresh decodes
every report in the window; measured on a two-worker laptop at 200 active endpoints and 5,700 requests per
second, that is 14 MB of reports and about 25 ms.

### GET /akamai/sureroute-test-object.html

Static HTML content for Akamai SureRoute testing.

```shell
curl http://localhost:9926/akamai/sureroute-test-object.html
```

## Configuration

Optional configuration in `harper-config.yaml` (`harperdb-config.yaml` before Harper 5):

```yaml
akamaiStatus:
  loadThresholds:
    scale: 1000 # Load reported when every worker's event loop is busy the whole window (default: 1000)
    max: 1000 # Reported when load cannot be measured, and the clamp on any reading (default: scale)
    windowSeconds: 60 # Span of raw reports averaged per poll (default: analytics.aggregatePeriod)
```

`windowSeconds` is clamped to at most what core retains, $`R`$, which is `analytics.rawRetentionMs` (1 hour
by default) but never less than one aggregation period $`p`$, so the window never divides by time core has
already cleaned up. It is also clamped to at least 30s, GTM's poll interval, so an idle node always has a
report in the window:

```math
W = \min\big(\max(\mathit{windowSeconds},\ \min(30\,\mathrm{s},\ R)),\ R\big), \qquad
R = \max(\mathit{rawRetentionMs},\ p)
```

When core retains less than 30s, because `analytics.aggregatePeriod` is itself shorter, the floor follows
the retained span, and a node that receives nothing but GTM's polls reads `max` on every poll that finds no
report in the window. A clamped value is logged once at load.

`scale` only sets the resolution of the number; GTM compares datacenters relative to each other. `max` is
what a node reports when its load cannot be measured, so GTM shifts traffic away from it; by default it
equals `scale`, the reading of a fully busy node, so it is the same value 1.0.0 reported. The GTM resource's
upper bound must be 0 (the default, no check) or at least `max`. GTM rejects a load object above the upper
bound whole and keeps using the last values it accepted, so a node that could no longer measure its load
would go on reporting its last reading.

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
