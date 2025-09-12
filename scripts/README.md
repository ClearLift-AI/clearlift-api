# R2 Data Lake Bulk Loader

Python scripts for bulk loading conversion event data into Cloudflare R2 Data Lake using Apache Iceberg table format.

## Overview

This toolkit provides a complete solution for loading event data into your R2 Data Lake, which can then be queried using DuckLake (DuckDB) through your Cloudflare Worker API.

### Components

1. **bulk_load_events.py** - Main script for loading data into R2 via PyIceberg
2. **generate_sample_events.py** - Generate realistic test data
3. **config.yaml** - Configuration file for connection settings

## Setup

### Prerequisites

- Python 3.8 or higher
- Cloudflare account with R2 bucket and Data Catalog enabled
- API token with R2 and Data Catalog permissions

### Installation

```bash
# Install dependencies
pip install -r requirements.txt
```

### Configuration

1. Copy the environment variables from your `.env` file or set them:

```bash
export CLOUDFLARE_API_TOKEN="your-api-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export DATALAKE_CATALOG_URI="https://catalog.cloudflarestorage.com/..."
export DATALAKE_WAREHOUSE_NAME="your-warehouse-name"
```

2. Or update `config.yaml` with your settings (not recommended for production).

## Usage

### Generate Sample Data

First, generate some sample event data for testing:

```bash
# Generate 10,000 events over 30 days
python generate_sample_events.py \
  --output sample_events.csv \
  --count 10000 \
  --days 30 \
  --org-id "your-org-id"

# Generate user journey data (more realistic patterns)
python generate_sample_events.py \
  --output journeys.parquet \
  --format parquet \
  --count 5000 \
  --journeys \
  --org-id "your-org-id"
```

### Bulk Load Events

Load events into your R2 Data Lake:

```bash
# Basic usage
python bulk_load_events.py \
  --input sample_events.csv \
  --org-id "your-org-id"

# Dry run to validate data
python bulk_load_events.py \
  --input sample_events.csv \
  --org-id "your-org-id" \
  --dry-run

# Load with statistics
python bulk_load_events.py \
  --input sample_events.csv \
  --org-id "your-org-id" \
  --stats

# Load different formats
python bulk_load_events.py \
  --input events.json \
  --format json \
  --org-id "your-org-id"

python bulk_load_events.py \
  --input events.parquet \
  --format parquet \
  --org-id "your-org-id"
```

## Data Format

The loader expects events with the following schema:

```json
{
  "id": "unique-event-id",
  "organization_id": "org-123",
  "event_id": "evt-456",
  "timestamp": "2024-01-15T10:30:00Z",
  "event_type": "purchase",
  "event_value": 99.99,
  "currency": "USD",
  "user_id": "user-789",
  "session_id": "session-abc",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "summer_sale",
  "device_type": "mobile",
  "browser": "Chrome",
  "country": "US",
  "attribution_path": "google > facebook > direct"
}
```

Required fields:
- `organization_id`
- `timestamp` (ISO 8601 format)
- `event_type`
- `event_value` (numeric)
- `currency`
- `user_id`
- `session_id`

Optional fields:
- `utm_source`, `utm_medium`, `utm_campaign`
- `device_type`, `browser`
- `country`
- `attribution_path`

## Supported File Formats

- **CSV** - Standard comma-separated values
- **JSON** - Array of event objects
- **JSONL** - Newline-delimited JSON (one event per line)
- **Parquet** - Apache Parquet format (recommended for large datasets)

## Performance Tips

1. **Use Parquet format** for best performance with large datasets
2. **Batch size** - Adjust `batch_size` in config.yaml (default: 10,000)
3. **Compression** - Use snappy compression for balance of speed and size
4. **Partitioning** - Data is automatically partitioned by organization, month, and day

## Querying Data

Once loaded, you can query your data through the API:

```bash
# Query via API endpoint
curl -X POST https://your-api.workers.dev/events/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "SELECT COUNT(*) FROM r2_catalog.default.conversion_events WHERE organization_id = '\''your-org-id'\''"
  }'

# Get conversion metrics
curl "https://your-api.workers.dev/events/conversions?organization_id=your-org-id&start_date=2024-01-01"
```

## Advanced Usage

### Custom Validation

The loader includes built-in validation, but you can customize it in `config.yaml`:

```yaml
validation:
  strict_mode: true  # Fail on any error
  max_errors: 10     # Stop after 10 errors
  log_errors: true   # Log all validation errors
```

### Parallel Processing

For very large datasets, you can split your data and run multiple loaders:

```bash
# Split large file
split -l 100000 large_dataset.csv chunk_

# Load chunks in parallel
for chunk in chunk_*; do
  python bulk_load_events.py --input "$chunk" --org-id "your-org-id" &
done
wait
```

### Table Management

The script automatically creates the Iceberg table if it doesn't exist. The table uses:
- Parquet file format
- Snappy compression
- Partitioning by organization, month, and day
- Optimized for time-series queries

## Troubleshooting

### Common Issues

1. **Authentication Error**
   - Ensure your API token has both R2 and Data Catalog permissions
   - Check that environment variables are set correctly

2. **Table Not Found**
   - The script will create the table automatically on first run
   - Ensure you have write permissions to the catalog

3. **Memory Issues**
   - Reduce `batch_size` in config.yaml
   - Use Parquet format for better memory efficiency

4. **Slow Performance**
   - Use Parquet format instead of CSV/JSON
   - Increase `batch_size` if you have sufficient memory
   - Ensure good network connectivity to Cloudflare

### Debug Mode

Enable verbose logging for troubleshooting:

```bash
python bulk_load_events.py \
  --input data.csv \
  --org-id "your-org-id" \
  --verbose
```

## Security Notes

- Never commit API tokens to version control
- Use environment variables for sensitive configuration
- Rotate API tokens regularly
- Use read-only tokens when possible for query operations

## Integration with DuckLake

The data loaded by this script is immediately available for querying through your DuckLake container. The API endpoints will automatically pick up new data without any additional configuration.

Example workflow:
1. Load data using this script
2. Query via `/events/query` endpoint
3. Get analytics via `/events/conversions` and `/events/insights`
4. Use the `/events/sync` endpoint for real-time updates

## Support

For issues or questions:
- Check the troubleshooting section above
- Review the Cloudflare R2 Data Catalog documentation
- Examine the API logs for detailed error messages