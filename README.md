# @harperfast/akamai-status

This component provides endpoints for Akamai services to determine Harper instance health, status, and load for traffic routing.

## Endpoints

| Endpoint                             | Method        | Description                           |
| ------------------------------------ | ------------- | ------------------------------------- |
| `/status`                            | GET           | Health check for Akamai routing       |
| `/status`                            | POST / DELETE | Set this node Available / Unavailable |
| `/current_load_for_gtm`              | GET           | Load feedback for Akamai GTM          |
| `/akamai/sureroute-test-object.html` | GET           | Static HTML for SureRoute testing     |

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

Returns server load for Akamai GTM: how much request handling this node has in flight, per worker thread.

```shell
curl http://localhost:9926/current_load_for_gtm
# load:39
```

The body is `load:N`, served as `text/plain` and unquoted, so GTM's `load:` leader-string parse works on
the raw bytes. `N` is the average number of requests inside a handler at once, per worker, over the last
window, times `scale`. With the default `scale` of 1000, `load:1000` means one request continuously in
flight on every worker, whether that request is computing or waiting on storage or an origin; `load:39`
is the two-worker stage node serving 8,800 requests a minute at half a millisecond each; an idle node
reports `load:0`. A node past saturation reports more than `scale`: that is a real reading, not an error,
and only `max` clamps it.

The figure is built from the `duration` metric core already records for every HTTP response: the
response count and mean handler time per path and method, failed responses included. Each HTTP worker
flushes those as a raw analytics report about once a second while it serves requests, into
`system.hdb_raw_analytics`, a table core keeps per node and never replicates. Summing count times mean
over this node's reports from the last window gives the milliseconds of handler time in that window;
dividing by the window and by the worker count gives the work in flight per worker. The window is one
analytics aggregation period by default (`analytics.aggregatePeriod`, 60s), the same span the aggregate
rows describe, so the number means the same thing as it would from them; reading the raw reports instead
keeps the scan bounded by this node's workers rather than by the cluster, and moves the value every
second rather than once per aggregation cycle.

This is the kind of feedback resource Akamai's documentation asks for: GTM treats loads as unit-less,
compares one property's datacenters against each other, and expects the value to rise with the traffic it
steers and with nothing else. Only HTTP requests move this number; replication, compaction, MQTT and cache
revalidation never enter it. Because a slow request counts for more than a fast one, a datacenter serving
cache misses or expensive queries reports more load than one serving the same request count from cache,
and as a node approaches saturation its handler times stretch and the figure rises ahead of failure. The
per-worker normalization makes nodes of different sizes comparable with equal GTM weights. CPU, memory and
event-loop utilization are deliberately not used; Akamai advises against them because background work
moves them, and on Fabric the event-loop figure is distorted by harper-pro's profiler.

What the clock does not cover: TLS handshakes, request parsing and any wait before the handler runs, the
transfer of the response body to the client, and work on threads other than the HTTP workers. Handshake
and transfer times are paced by the client's distance, so counting them would make load depend on where
GTM's clients are rather than on what the node does. A request is counted when its response is ready, in
the report that covers that second, so a request longer than the window is invisible until it completes.
A single saturated worker among idle ones is visible only through its stretched handler times, because
`duration` is not recorded per thread.

GTM balances datacenters, not nodes. The GTM resource aggregates its datacenter's load servers (median on
Fabric), so with several nodes in one datacenter GTM sees one number for all of them and cannot shed from
one node alone. Nodes in one datacenter should be the same size.

Core writes a report only for a worker that recorded something in that second, and GTM's own liveness and
load polls are requests, so a window with no reports at all means analytics are not being written: the
endpoint reports `max`, which takes the node out of GTM rotation. The same happens when the raw analytics
query fails. Entering and leaving this state is logged at `warn`, once per episode rather than once per
poll. A node that is up but idle still has reports, from the polls themselves, and reads `load:0`.

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
    scale: 1000 # Load reported when every worker is continuously busy with requests (default: 1000)
    max: 100000 # Reported when load cannot be measured, and the clamp on any reading (default: 100000)
    windowSeconds: 60 # Span of raw reports averaged per poll (default: analytics.aggregatePeriod)
```

`windowSeconds` is clamped to at most what core retains, `analytics.rawRetentionMs` (1 hour by default,
never less than one aggregation period), so the window never divides by time core has already cleaned up,
and to at least 30s, GTM's poll interval, so an idle node always has a report in the window. When core
retains less than 30s, because `analytics.aggregatePeriod` is itself shorter, the floor follows the retained
span, and a node that receives nothing but GTM's polls reads `max` on every poll that finds no report in
the window. A clamped value is logged once at load.

`scale` only sets the resolution of the number; GTM compares datacenters relative to each other. `max` is
a fail-safe, not a working range: it is what a node reports when its analytics are missing, so GTM
shifts traffic away from it. The GTM resource's upper bound must be 0 (no check) or at least `max`, or
GTM rejects the fail-safe value as invalid.

**Examples:**

Default, two workers, 0.08 requests in flight per worker on average → `load:80`

Saturated node, handler times stretched, 1.5 requests in flight per worker → `load:1500`

Analytics not being written → `load:100000`
