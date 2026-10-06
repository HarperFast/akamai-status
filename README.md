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

Returns server load for Akamai GTM based on this node's HTTP request rate.

```shell
curl http://localhost:9926/current_load_for_gtm
# load:200
```

Response format is `load:N` where N is `(requests per second ÷ targetRps) × scale`, capped at `max`. The body is served as `text/plain`, unquoted, so GTM's `load:` leader-string parse works on the raw bytes.

The rate is computed from the `success` analytics metric, which core records for every HTTP request and
aggregates once per analytics aggregation period (`analytics.aggregatePeriod`, 60s by default). Each
aggregate row's `total` is the number of requests for one path and method and its `count` the number that
succeeded; the component sums `total`, so a node that starts failing requests does not report falling load. Request
count is Akamai's recommended kind of load feedback resource; it idles at zero and rises with exactly the
traffic GTM steers. Event-loop or CPU utilization do neither, and Akamai's documentation advises against
them. The response cache and the lookback window are both derived from the aggregation period, so the
endpoint keeps its scan rate proportional to how often the number can actually change.

Core also writes a `resource-usage` row every aggregation cycle whether or not any request arrived, so
the newest cycle is dated by whichever metric was written last. A node whose newest cycle carries no
request rows reports `load:0`, even while an older cycle inside the lookback window still holds a busy
count. If the window holds no rows of either metric for this node, or the query fails, the endpoint
reports max load, which takes the node out of GTM rotation. That is expected when analytics have
stopped being written, or after a node was down for longer than the window; entering and leaving this
state is logged at `warn`, once per episode rather than once per poll.

The lookback window is two aggregation periods (minimum 120s), so raising `analytics.aggregatePeriod`
does not strand the endpoint at max load.

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
    targetRps: 1000 # Request rate that maps to full scale (default: 1000)
    scale: 1000 # Load value reported at targetRps (default: 1000)
    max: 1000 # Maximum load value cap (default: scale value)
```

`targetRps` anchors what "fully loaded" means for the instance and should be set per instance size; GTM
compares the reported loads across datacenters, so the anchor should mean the same thing on each.

**Examples:**

Default: 200 req/s → `load:200`

With `targetRps: 400`: 200 req/s → `load:500`

With `max: 500`: 800 req/s → `load:500` (capped)
