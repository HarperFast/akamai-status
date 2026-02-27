# @harperdb/akamai-status

This component provides endpoints for Akamai services to determine Harper instance health, status, and load for traffic routing.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Health check for Akamai routing |
| `/current_load_for_gtm` | GET | Load feedback for Akamai GTM |
| `/akamai/sureroute-test-object.html` | GET | Static HTML for SureRoute testing |

## Usage

### GET /status

Returns the current operational status of the Harper instance.

- Returns HTTP `200` when status is "Available"
- Returns HTTP `404` otherwise
```shell
curl http://localhost:9926/status
# "Status endpoint is reporting for duty."
```

Status is controlled via the operations API:
```shell
# Set available
curl -X POST http://localhost:9925 \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $AUTH" \
  -d '{"operation": "set_status", "id": "availability", "status": "Available"}'

# Set unavailable
curl -X POST http://localhost:9925 \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $AUTH" \
  -d '{"operation": "set_status", "id": "availability", "status": "Unavailable"}'
```

### GET /current_load_for_gtm

Returns server load for Akamai GTM based on worker thread utilization.
```shell
curl http://localhost:9926/current_load_for_gtm
# "load:651"
```

Response format is `load:N` where N is `utilization × scale`, capped at `max`.

Load values are cached for 2 seconds. If utilization data is unavailable or an error occurs, returns max load.

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
    scale: 1000    # Multiplier for utilization (default: 1000)
    max: 1000      # Maximum load value cap (default: scale value)
```

**Examples:**

Default: utilization 0.65 → `load:650`

With `scale: 100`: utilization 0.65 → `load:65`

With `max: 500`: utilization 0.65 → `load:500` (capped)
