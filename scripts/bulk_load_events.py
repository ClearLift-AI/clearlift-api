#!/usr/bin/env python3
"""
Bulk Event Loader for Cloudflare R2 Data Lake
Loads conversion event data into Apache Iceberg tables via PyIceberg
"""

import os
import sys
import json
import yaml
import argparse
import logging
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from pathlib import Path
import uuid
from tqdm import tqdm
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg import schema, types, partitioning, transforms
import boto3
from botocore.config import Config

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class EventBulkLoader:
    """Handles bulk loading of events to R2 Data Lake via Iceberg tables"""
    
    def __init__(self, config_path: str = "config.yaml"):
        """Initialize the bulk loader with configuration"""
        self.config = self._load_config(config_path)
        self.catalog = None
        self.s3_client = None
        self._setup_connections()
    
    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """Load configuration from YAML file or environment variables"""
        config = {}
        
        # Try to load from config file
        config_file = Path(config_path)
        if config_file.exists():
            with open(config_file, 'r') as f:
                config = yaml.safe_load(f)
        
        # Override with environment variables if present
        env_mapping = {
            'DATALAKE_CATALOG_URI': 'catalog_uri',
            'DATALAKE_WAREHOUSE_NAME': 'warehouse_name',
            'CLOUDFLARE_API_TOKEN': 'api_token',
            'CLOUDFLARE_ACCOUNT_ID': 'account_id',
            'R2_S3_API_URL': 's3_endpoint',
            'R2_BUCKET': 'bucket_name'
        }
        
        for env_key, config_key in env_mapping.items():
            if env_value := os.getenv(env_key):
                config[config_key] = env_value
        
        # Validate required fields
        required_fields = ['catalog_uri', 'warehouse_name', 'api_token']
        missing_fields = [f for f in required_fields if f not in config]
        if missing_fields:
            raise ValueError(f"Missing required configuration: {', '.join(missing_fields)}")
        
        # Set defaults
        config.setdefault('batch_size', 10000)
        config.setdefault('namespace', 'default')
        config.setdefault('table_name', 'conversion_events')
        
        return config
    
    def _setup_connections(self):
        """Setup connections to R2 and Iceberg catalog"""
        # Setup Iceberg REST catalog
        self.catalog = RestCatalog(
            name="r2_catalog",
            uri=self.config['catalog_uri'],
            token=self.config['api_token'],
            warehouse=self.config['warehouse_name']
        )
        
        # Setup S3 client for direct R2 access if needed
        if 's3_endpoint' in self.config:
            self.s3_client = boto3.client(
                's3',
                endpoint_url=self.config['s3_endpoint'],
                aws_access_key_id=self.config.get('account_id', ''),
                aws_secret_access_key=self.config['api_token'],
                config=Config(signature_version='s3v4'),
                region_name='auto'
            )
    
    def _get_event_schema(self):
        """Define the Iceberg schema for conversion events"""
        return schema.Schema(
            types.NestedField(1, "id", types.StringType(), required=True),
            types.NestedField(2, "organization_id", types.StringType(), required=True),
            types.NestedField(3, "event_id", types.StringType(), required=True),
            types.NestedField(4, "timestamp", types.TimestampType(), required=True),
            types.NestedField(5, "event_type", types.StringType(), required=True),
            types.NestedField(6, "event_value", types.DoubleType(), required=True),
            types.NestedField(7, "currency", types.StringType(), required=True),
            types.NestedField(8, "user_id", types.StringType(), required=True),
            types.NestedField(9, "session_id", types.StringType(), required=True),
            types.NestedField(10, "utm_source", types.StringType(), required=False),
            types.NestedField(11, "utm_medium", types.StringType(), required=False),
            types.NestedField(12, "utm_campaign", types.StringType(), required=False),
            types.NestedField(13, "device_type", types.StringType(), required=False),
            types.NestedField(14, "browser", types.StringType(), required=False),
            types.NestedField(15, "country", types.StringType(), required=False),
            types.NestedField(16, "attribution_path", types.StringType(), required=False),
        )
    
    def _get_partition_spec(self):
        """Define partitioning strategy for the table"""
        return partitioning.PartitionSpec(
            partitioning.PartitionField(
                source_id=2,  # organization_id
                field_id=1000,
                transform=transforms.TruncateTransform(10),
                name="organization_bucket"
            ),
            partitioning.PartitionField(
                source_id=4,  # timestamp
                field_id=1001,
                transform=transforms.MonthTransform(),
                name="month"
            ),
            partitioning.PartitionField(
                source_id=4,  # timestamp
                field_id=1002,
                transform=transforms.DayTransform(),
                name="day"
            )
        )
    
    def create_or_get_table(self):
        """Create the Iceberg table if it doesn't exist"""
        table_identifier = f"{self.config['namespace']}.{self.config['table_name']}"
        
        try:
            # Try to load existing table
            table = self.catalog.load_table(table_identifier)
            logger.info(f"Table {table_identifier} already exists")
            return table
        except Exception as e:
            # Table doesn't exist, create it
            logger.info(f"Creating new table {table_identifier}")
            
            schema = self._get_event_schema()
            partition_spec = self._get_partition_spec()
            
            table = self.catalog.create_table(
                identifier=table_identifier,
                schema=schema,
                partition_spec=partition_spec,
                properties={
                    'write.format.default': 'parquet',
                    'write.parquet.compression-codec': 'snappy',
                    'write.metadata.compression-codec': 'gzip',
                    'write.summary.partition-limit': '100',
                    'write.metadata.delete-after-commit.enabled': 'true',
                    'write.metadata.previous-versions-max': '10'
                }
            )
            
            logger.info(f"Table {table_identifier} created successfully")
            return table
    
    def validate_events(self, events: List[Dict[str, Any]], organization_id: str) -> List[Dict[str, Any]]:
        """Validate and normalize event data"""
        validated_events = []
        
        for event in events:
            # Ensure required fields
            if not event.get('id'):
                event['id'] = str(uuid.uuid4())
            
            event['organization_id'] = organization_id
            
            # Ensure timestamp is properly formatted
            if 'timestamp' in event:
                if isinstance(event['timestamp'], str):
                    # Parse ISO format timestamp
                    event['timestamp'] = pd.to_datetime(event['timestamp'])
                elif not isinstance(event['timestamp'], (pd.Timestamp, datetime)):
                    event['timestamp'] = pd.to_datetime(event['timestamp'])
            else:
                event['timestamp'] = datetime.now(timezone.utc)
            
            # Set defaults for required fields
            event.setdefault('event_id', str(uuid.uuid4()))
            event.setdefault('event_type', 'conversion')
            event.setdefault('event_value', 0.0)
            event.setdefault('currency', 'USD')
            event.setdefault('user_id', 'unknown')
            event.setdefault('session_id', str(uuid.uuid4()))
            
            # Ensure numeric fields are correct type
            event['event_value'] = float(event['event_value'])
            
            validated_events.append(event)
        
        return validated_events
    
    def load_events_from_file(self, file_path: str, file_format: str = 'auto') -> pd.DataFrame:
        """Load events from various file formats"""
        file_path = Path(file_path)
        
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        # Auto-detect format if not specified
        if file_format == 'auto':
            suffix = file_path.suffix.lower()
            format_map = {
                '.csv': 'csv',
                '.json': 'json',
                '.jsonl': 'jsonl',
                '.parquet': 'parquet',
                '.pq': 'parquet'
            }
            file_format = format_map.get(suffix, 'csv')
        
        logger.info(f"Loading {file_format} file: {file_path}")
        
        if file_format == 'csv':
            df = pd.read_csv(file_path)
        elif file_format == 'json':
            df = pd.read_json(file_path, orient='records')
        elif file_format == 'jsonl':
            df = pd.read_json(file_path, orient='records', lines=True)
        elif file_format == 'parquet':
            df = pd.read_parquet(file_path)
        else:
            raise ValueError(f"Unsupported file format: {file_format}")
        
        logger.info(f"Loaded {len(df)} events from file")
        return df
    
    def bulk_load(self, 
                  input_file: str,
                  organization_id: str,
                  file_format: str = 'auto',
                  dry_run: bool = False) -> int:
        """Main method to bulk load events"""
        
        # Load events from file
        df = self.load_events_from_file(input_file, file_format)
        
        # Convert to list of dictionaries for validation
        events = df.to_dict('records')
        
        # Validate events
        logger.info("Validating events...")
        validated_events = self.validate_events(events, organization_id)
        
        if dry_run:
            logger.info(f"DRY RUN: Would load {len(validated_events)} events")
            logger.info(f"Sample event: {json.dumps(validated_events[0], default=str, indent=2)}")
            return len(validated_events)
        
        # Create or get table
        table = self.create_or_get_table()
        
        # Convert back to DataFrame with proper schema
        df_validated = pd.DataFrame(validated_events)
        
        # Ensure proper column order matching schema
        column_order = [
            'id', 'organization_id', 'event_id', 'timestamp',
            'event_type', 'event_value', 'currency', 'user_id',
            'session_id', 'utm_source', 'utm_medium', 'utm_campaign',
            'device_type', 'browser', 'country', 'attribution_path'
        ]
        
        # Add missing columns with None
        for col in column_order:
            if col not in df_validated.columns:
                df_validated[col] = None
        
        df_validated = df_validated[column_order]
        
        # Convert to PyArrow table
        arrow_table = pa.Table.from_pandas(df_validated)
        
        # Load in batches
        batch_size = self.config['batch_size']
        total_rows = len(df_validated)
        num_batches = (total_rows + batch_size - 1) // batch_size
        
        logger.info(f"Loading {total_rows} events in {num_batches} batches...")
        
        with tqdm(total=total_rows, desc="Loading events") as pbar:
            for i in range(0, total_rows, batch_size):
                batch_end = min(i + batch_size, total_rows)
                batch = arrow_table.slice(i, batch_end - i)
                
                # Append batch to table
                table.append(batch)
                
                pbar.update(batch_end - i)
        
        logger.info(f"Successfully loaded {total_rows} events")
        return total_rows
    
    def query_table_stats(self) -> Dict[str, Any]:
        """Query basic statistics about the table"""
        table_identifier = f"{self.config['namespace']}.{self.config['table_name']}"
        
        try:
            table = self.catalog.load_table(table_identifier)
            
            # Get table metadata
            snapshots = list(table.metadata.snapshots)
            current_snapshot = table.current_snapshot()
            
            stats = {
                'table_name': table_identifier,
                'row_count': current_snapshot.summary.get('total-records', 0) if current_snapshot else 0,
                'file_count': current_snapshot.summary.get('total-data-files', 0) if current_snapshot else 0,
                'total_size_bytes': current_snapshot.summary.get('total-file-size-bytes', 0) if current_snapshot else 0,
                'snapshot_count': len(snapshots),
                'last_updated': datetime.fromtimestamp(
                    current_snapshot.timestamp_ms / 1000
                ).isoformat() if current_snapshot else None
            }
            
            # Convert size to human-readable format
            size_bytes = stats['total_size_bytes']
            for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
                if size_bytes < 1024.0:
                    stats['total_size'] = f"{size_bytes:.2f} {unit}"
                    break
                size_bytes /= 1024.0
            
            return stats
        except Exception as e:
            logger.error(f"Failed to get table stats: {e}")
            return {}


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Bulk load events into Cloudflare R2 Data Lake'
    )
    parser.add_argument(
        '--input', '-i',
        required=True,
        help='Input file path (CSV, JSON, JSONL, or Parquet)'
    )
    parser.add_argument(
        '--org-id', '-o',
        required=True,
        help='Organization ID for the events'
    )
    parser.add_argument(
        '--format', '-f',
        default='auto',
        choices=['auto', 'csv', 'json', 'jsonl', 'parquet'],
        help='Input file format (default: auto-detect)'
    )
    parser.add_argument(
        '--config', '-c',
        default='config.yaml',
        help='Configuration file path (default: config.yaml)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Validate data without loading'
    )
    parser.add_argument(
        '--stats',
        action='store_true',
        help='Show table statistics after loading'
    )
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Enable verbose logging'
    )
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    try:
        # Initialize loader
        loader = EventBulkLoader(args.config)
        
        # Load events
        count = loader.bulk_load(
            input_file=args.input,
            organization_id=args.org_id,
            file_format=args.format,
            dry_run=args.dry_run
        )
        
        # Show stats if requested
        if args.stats and not args.dry_run:
            stats = loader.query_table_stats()
            if stats:
                print("\nTable Statistics:")
                print("-" * 40)
                for key, value in stats.items():
                    print(f"{key:20}: {value}")
        
        return 0
        
    except Exception as e:
        logger.error(f"Failed to load events: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())