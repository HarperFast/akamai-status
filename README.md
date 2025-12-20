# @harperdb/akamai-status

This component provides endpoints for Akamai services to determine Harper instance health, status, and load for traffic routing and monitoring.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Health check for Akamai routing |
| `/current_load_for_gtm` | GET | Load feedback for Akamai GTM |
| `/akamai/sureroute-test-object.html` | GET | Static HTML for SureRoute testing |

## Usage

### GET /status

Returns the current operational status of the Harper instance. 

- Returns HTTP `200` when status is "Ready"
- Returns HTTP `404` otherwise
```shell
curl http://localhost:9926/status
```

### GET /current_load_for_gtm

Returns server load metrics for Akamai GTM. 
```shell
curl http://localhost:9926/current_load_for_gtm
# Example output: load:750
```

Response format is `load:N` where N is a value from 0 to 1000 (configurable).

### GET /akamai/sureroute-test-object.html

Serves static HTML content for Akamai SureRoute testing. 
```shell
curl http://localhost:9926/akamai/sureroute-test-object.html
```

## Configuration

Optional configuration in `harperdb-config.yaml`:
```yaml
akamaiStatus:
  loadFeedbackMetrics:    # Metrics to include in load calculation
    - threads             # Worker thread utilization (default, weight 0.7)
    - cpu                 # CPU utilization (weight 0.2)
    - memory              # Heap memory utilization (weight 0.1)
  loadThresholds:
    scale: 1000           # Load range 0-N (default 1000)
    max: 1000             # Cap value (default = scale)
```
