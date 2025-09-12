#!/usr/bin/env python3
"""
Generate sample conversion event data for testing the bulk loader
"""

import json
import csv
import random
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import uuid
from typing import List, Dict, Any
import pandas as pd
import pyarrow.parquet as pq

# Sample data pools
EVENT_TYPES = [
    'page_view', 'add_to_cart', 'checkout', 'purchase', 
    'signup', 'login', 'subscription', 'download',
    'video_play', 'form_submit', 'click', 'scroll'
]

UTM_SOURCES = [
    'google', 'facebook', 'twitter', 'linkedin', 'instagram',
    'email', 'direct', 'organic', 'referral', 'youtube'
]

UTM_MEDIUMS = [
    'cpc', 'cpm', 'social', 'email', 'organic', 
    'referral', 'display', 'video', 'affiliate'
]

UTM_CAMPAIGNS = [
    'summer_sale', 'black_friday', 'new_product', 'brand_awareness',
    'retargeting', 'newsletter', 'webinar', 'ebook_download'
]

DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'tv', 'wearable']

BROWSERS = [
    'Chrome', 'Safari', 'Firefox', 'Edge', 'Opera',
    'Samsung Internet', 'UC Browser', 'Mobile Safari'
]

COUNTRIES = [
    'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'BR',
    'IN', 'CN', 'MX', 'ES', 'IT', 'NL', 'SE', 'KR'
]

CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD']


class EventGenerator:
    """Generate realistic conversion event data"""
    
    def __init__(self, organization_id: str, seed: int = None):
        """Initialize the generator"""
        self.organization_id = organization_id
        if seed:
            random.seed(seed)
        
        # Create pools of user and session IDs for realistic patterns
        self.user_pool = [f"user_{uuid.uuid4().hex[:8]}" for _ in range(100)]
        self.session_pool = []
    
    def generate_event(self, base_time: datetime) -> Dict[str, Any]:
        """Generate a single event"""
        event_type = random.choice(EVENT_TYPES)
        
        # Generate event value based on type
        if event_type == 'purchase':
            event_value = round(random.uniform(10, 500), 2)
        elif event_type in ['subscription', 'checkout']:
            event_value = round(random.uniform(20, 200), 2)
        elif event_type in ['add_to_cart']:
            event_value = round(random.uniform(5, 100), 2)
        else:
            event_value = 0.0
        
        # Select or create user/session
        user_id = random.choice(self.user_pool)
        
        # 70% chance of existing session, 30% new session
        if self.session_pool and random.random() < 0.7:
            session_id = random.choice(self.session_pool)
        else:
            session_id = f"session_{uuid.uuid4().hex[:12]}"
            self.session_pool.append(session_id)
            if len(self.session_pool) > 50:  # Keep pool size manageable
                self.session_pool.pop(0)
        
        # Random timestamp within the hour
        timestamp = base_time + timedelta(
            minutes=random.randint(0, 59),
            seconds=random.randint(0, 59)
        )
        
        event = {
            'id': str(uuid.uuid4()),
            'organization_id': self.organization_id,
            'event_id': f"evt_{uuid.uuid4().hex[:12]}",
            'timestamp': timestamp.isoformat(),
            'event_type': event_type,
            'event_value': event_value,
            'currency': random.choice(CURRENCIES) if event_value > 0 else 'USD',
            'user_id': user_id,
            'session_id': session_id
        }
        
        # Add optional fields with varying probability
        if random.random() < 0.8:  # 80% have UTM params
            event['utm_source'] = random.choice(UTM_SOURCES)
            event['utm_medium'] = random.choice(UTM_MEDIUMS)
            
            if random.random() < 0.6:  # 60% have campaign
                event['utm_campaign'] = random.choice(UTM_CAMPAIGNS)
        
        if random.random() < 0.9:  # 90% have device info
            event['device_type'] = random.choice(DEVICE_TYPES)
            event['browser'] = random.choice(BROWSERS)
        
        if random.random() < 0.95:  # 95% have country
            event['country'] = random.choice(COUNTRIES)
        
        if random.random() < 0.3:  # 30% have attribution path
            path_length = random.randint(1, 4)
            path_sources = random.sample(UTM_SOURCES, min(path_length, len(UTM_SOURCES)))
            event['attribution_path'] = ' > '.join(path_sources)
        
        return event
    
    def generate_events(self, 
                        num_events: int,
                        start_date: datetime,
                        end_date: datetime) -> List[Dict[str, Any]]:
        """Generate multiple events over a time range"""
        events = []
        
        # Calculate time range
        time_diff = end_date - start_date
        hours = int(time_diff.total_seconds() / 3600)
        
        # Distribute events across time range
        events_per_hour = max(1, num_events // hours)
        
        current_time = start_date
        remaining_events = num_events
        
        while remaining_events > 0 and current_time < end_date:
            # Add some variation to events per hour
            hour_events = min(
                remaining_events,
                max(1, events_per_hour + random.randint(-5, 10))
            )
            
            for _ in range(hour_events):
                events.append(self.generate_event(current_time))
                remaining_events -= 1
                
                if remaining_events <= 0:
                    break
            
            current_time += timedelta(hours=1)
        
        return events
    
    def generate_user_journey(self, 
                             user_id: str,
                             session_id: str,
                             start_time: datetime) -> List[Dict[str, Any]]:
        """Generate a realistic user journey with multiple events"""
        journey_events = []
        current_time = start_time
        
        # Typical user journey
        journey_sequence = [
            ('page_view', 0, 0),
            ('click', 1, 0),
            ('page_view', 2, 0),
            ('add_to_cart', 5, random.uniform(20, 100)),
            ('checkout', 8, 0),
            ('purchase', 10, random.uniform(20, 100))
        ]
        
        # Randomly truncate journey (not all users complete purchase)
        if random.random() < 0.4:  # 40% don't complete
            journey_sequence = journey_sequence[:random.randint(2, 4)]
        
        for event_type, minutes_later, value in journey_sequence:
            current_time += timedelta(minutes=minutes_later, seconds=random.randint(0, 59))
            
            event = {
                'id': str(uuid.uuid4()),
                'organization_id': self.organization_id,
                'event_id': f"evt_{uuid.uuid4().hex[:12]}",
                'timestamp': current_time.isoformat(),
                'event_type': event_type,
                'event_value': value if value > 0 else 0,
                'currency': 'USD',
                'user_id': user_id,
                'session_id': session_id,
                'utm_source': 'google',
                'utm_medium': 'cpc',
                'utm_campaign': 'summer_sale',
                'device_type': 'desktop',
                'browser': 'Chrome',
                'country': 'US'
            }
            
            journey_events.append(event)
        
        return journey_events


def save_events(events: List[Dict[str, Any]], 
                output_file: str,
                file_format: str = 'csv'):
    """Save events to file in specified format"""
    output_path = Path(output_file)
    
    if file_format == 'csv':
        with open(output_path, 'w', newline='') as f:
            if events:
                # Get all unique keys from all events
                all_keys = set()
                for event in events:
                    all_keys.update(event.keys())
                fieldnames = sorted(all_keys)
                
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(events)
        print(f"Saved {len(events)} events to {output_path} (CSV)")
    
    elif file_format == 'json':
        with open(output_path, 'w') as f:
            json.dump(events, f, indent=2, default=str)
        print(f"Saved {len(events)} events to {output_path} (JSON)")
    
    elif file_format == 'jsonl':
        with open(output_path, 'w') as f:
            for event in events:
                f.write(json.dumps(event, default=str) + '\n')
        print(f"Saved {len(events)} events to {output_path} (JSONL)")
    
    elif file_format == 'parquet':
        df = pd.DataFrame(events)
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        df.to_parquet(output_path, engine='pyarrow', compression='snappy')
        print(f"Saved {len(events)} events to {output_path} (Parquet)")
    
    else:
        raise ValueError(f"Unsupported format: {file_format}")


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Generate sample conversion event data'
    )
    parser.add_argument(
        '--output', '-o',
        default='sample_events.csv',
        help='Output file path'
    )
    parser.add_argument(
        '--format', '-f',
        choices=['csv', 'json', 'jsonl', 'parquet'],
        default='csv',
        help='Output file format (default: csv)'
    )
    parser.add_argument(
        '--count', '-n',
        type=int,
        default=1000,
        help='Number of events to generate (default: 1000)'
    )
    parser.add_argument(
        '--org-id',
        default='test-org-123',
        help='Organization ID for events (default: test-org-123)'
    )
    parser.add_argument(
        '--days', '-d',
        type=int,
        default=7,
        help='Number of days of data to generate (default: 7)'
    )
    parser.add_argument(
        '--seed', '-s',
        type=int,
        help='Random seed for reproducible data'
    )
    parser.add_argument(
        '--journeys',
        action='store_true',
        help='Generate realistic user journeys instead of random events'
    )
    
    args = parser.parse_args()
    
    # Calculate date range
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=args.days)
    
    # Initialize generator
    generator = EventGenerator(args.org_id, args.seed)
    
    if args.journeys:
        # Generate user journeys
        events = []
        events_per_journey = 5  # Average events per journey
        num_journeys = args.count // events_per_journey
        
        print(f"Generating {num_journeys} user journeys...")
        
        for i in range(num_journeys):
            # Random start time within date range
            journey_start = start_date + timedelta(
                seconds=random.randint(0, int((end_date - start_date).total_seconds()))
            )
            
            user_id = f"user_{uuid.uuid4().hex[:8]}"
            session_id = f"session_{uuid.uuid4().hex[:12]}"
            
            journey_events = generator.generate_user_journey(
                user_id, session_id, journey_start
            )
            events.extend(journey_events)
    else:
        # Generate random events
        print(f"Generating {args.count} random events over {args.days} days...")
        events = generator.generate_events(args.count, start_date, end_date)
    
    # Save to file
    save_events(events, args.output, args.format)
    
    # Print sample
    print("\nSample event:")
    print(json.dumps(events[0], indent=2, default=str))
    
    print(f"\nTotal events generated: {len(events)}")
    print(f"Date range: {start_date.date()} to {end_date.date()}")


if __name__ == '__main__':
    main()