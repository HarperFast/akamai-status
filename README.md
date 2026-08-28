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

Returns server load for Akamai GTM based on this node's event-loop utilization.

```shell
curl http://localhost:9926/current_load_for_gtm
# "load:651"
```

Response format is `load:N` where N is `utilization × scale`, capped at `max`.

The underlying `utilization` metric is the mean event-loop utilization across worker threads, aggregated
once per analytics aggregation period (`analytics.aggregatePeriod`, 60s by default). The response cache and the lookback
window are both derived from that period, so the endpoint keeps its scan rate proportional to how often
the number can actually change.

If utilization data is unavailable or the query fails, the endpoint reports max load, which takes the node
out of GTM rotation. That is expected for up to one aggregation period after a restart; entering and
leaving this state is logged at `warn`, once per episode rather than once per poll.

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
    scale: 1000 # Multiplier for utilization (default: 1000)
    max: 1000 # Maximum load value cap (default: scale value)
```

**Examples:**

Default: utilization 0.65 → `load:650`

With `scale: 100`: utilization 0.65 → `load:65`

With `max: 500`: utilization 0.65 → `load:500` (capped)
