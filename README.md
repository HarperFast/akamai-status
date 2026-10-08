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

Returns server load for Akamai GTM: how much request work this node has in flight, per worker thread.

```shell
curl http://localhost:9926/current_load_for_gtm
# load:39
```

The body is `load:N`, served as `text/plain` and unquoted, so GTM's `load:` leader-string parse works on
the raw bytes. `N` is the fraction of the node's worker capacity spent on request handling over the newest
analytics aggregation cycle, times `scale`. With the default `scale` of 1000, `load:1000` means every
worker was continuously busy with requests, `load:39` is the two-worker stage node serving 8,800 requests
a minute at half a millisecond each, and an idle node reports `load:0`. A node past saturation reports more
than `scale`: that is a real reading, not an error, and only `max` clamps it.

The figure is built from analytics core already records for every HTTP response: the `duration` metric
(response count and mean handler time per path and method, failed responses included) and, where this
node terminates TLS itself, the `tls-handshake` metric (new-connection count and mean handshake time per
port). Summing count times mean over the newest cycle gives the milliseconds of request work in the
period; dividing by the period and by the worker count gives the busy fraction per worker. Core
aggregates once per analytics aggregation period (`analytics.aggregatePeriod`, 60s by default).

This is the kind of feedback resource Akamai's documentation asks for: GTM treats loads as unit-less,
compares one property's datacenters against each other, and expects the value to rise with the traffic it
steers and with nothing else. Only HTTP requests move this number; replication, compaction, MQTT and cache
revalidation never enter it. Because a slow request counts for more than a fast one, a datacenter serving
cache misses or expensive queries reports more load than one serving the same request count from cache,
and as a node approaches saturation its handler times stretch and the figure rises ahead of failure. The
per-worker normalization makes nodes of different sizes comparable with equal GTM weights. CPU, memory and
event-loop utilization are deliberately not used; Akamai advises against them because background work
moves them, and on Fabric the event-loop figure is distorted by harper-pro's profiler.

What the clock does not cover: request parsing and any wait before the handler runs, the transfer of the
response body to the client, and work on threads other than the HTTP workers. A single saturated worker
among idle ones is visible only through its stretched handler times, because `duration` is not recorded
per thread.

GTM balances datacenters, not nodes. The GTM resource aggregates its datacenter's load servers (median on
Fabric), so with several nodes in one datacenter GTM sees one number for all of them and cannot shed from
one node alone. Nodes in one datacenter should be the same size.

Core also writes a `resource-usage` row every aggregation cycle whether or not any request arrived, so
the newest cycle is dated by whichever metric was written last. A node whose newest cycle carries no
request rows reports `load:0`, even while an older cycle inside the lookback window still holds a busy
count. If the window holds no rows of either metric for this node, or the query fails, the endpoint
reports `max`, which takes the node out of GTM rotation. That is expected when analytics have stopped
being written, or after a node was down for longer than the window; entering and leaving this state is
logged at `warn`, once per episode rather than once per poll.

The lookback window is two aggregation periods (minimum 120s), so raising `analytics.aggregatePeriod`
does not strand the endpoint at max load. The response is cached for half a period, since the underlying
rows only change once per period.

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
```

`scale` only sets the resolution of the number; GTM compares datacenters relative to each other. `max` is
a fail-safe, not a working range: it is what a node reports when its analytics are missing, so GTM
shifts traffic away from it. The GTM resource's upper bound must be 0 (no check) or at least `max`, or
GTM rejects the fail-safe value as invalid.

**Examples:**

Default, two workers, 0.08 of each worker busy with requests → `load:80`

Saturated node, handler times stretched, 1.5 of each worker's capacity in flight → `load:1500`

Analytics not being written → `load:100000`
