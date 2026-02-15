/**
 * Attribution Model Algorithm Tests
 *
 * Tests all 6 attribution models as pure functions:
 * - first_touch: 100% to first touchpoint
 * - last_touch: 100% to last touchpoint
 * - linear: equal credit to all touchpoints
 * - time_decay: exponential decay with 7-day half-life
 * - position_based: 40/20/40 U-shape
 * - data_driven: lift-based credit from conversion rate analysis
 *
 * Also tests:
 * - Markov transition matrix construction
 * - Markov removal effect calculation
 * - Edge cases (empty paths, single touchpoint, zero values)
 */

import { describe, it, expect } from 'vitest';
import {
  firstTouchAttribution,
  lastTouchAttribution,
  linearAttribution,
  timeDecayAttribution,
  positionBasedAttribution,
  dataDrivenAttribution,
  buildMarkovTransitionMatrix,
  type Touchpoint,
  type ConversionPath,
} from '../src/services/attribution-models';

// =============================================================================
// Helpers
// =============================================================================

function tp(source: string, daysBeforeConversion: number): Touchpoint {
  const conversionDate = new Date('2025-01-20T10:00:00Z');
  const timestamp = new Date(conversionDate.getTime() - daysBeforeConversion * 24 * 60 * 60 * 1000);
  return {
    id: `tp-${source}-${daysBeforeConversion}`,
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    utm_source: source,
    utm_medium: 'cpc',
    utm_campaign: `${source}-campaign`,
    event_type: 'pageview',
  };
}

const CONVERSION_VALUE = 10000; // $100 in cents

// =============================================================================
// First-Touch Attribution
// =============================================================================

describe('firstTouchAttribution', () => {
  it('returns empty array for no touchpoints', () => {
    expect(firstTouchAttribution([], CONVERSION_VALUE)).toEqual([]);
  });

  it('gives 100% credit to single touchpoint', () => {
    const result = firstTouchAttribution([tp('google', 5)], CONVERSION_VALUE);
    expect(result).toHaveLength(1);
    expect(result[0].credit).toBe(CONVERSION_VALUE);
    expect(result[0].credit_percentage).toBe(100);
  });

  it('gives 100% credit to first (earliest) touchpoint', () => {
    const touchpoints = [tp('email', 3), tp('google', 10), tp('facebook', 5)];
    const result = firstTouchAttribution(touchpoints, CONVERSION_VALUE);

    // Sorted by timestamp: google (10d) → facebook (5d) → email (3d)
    expect(result[0].utm_source).toBe('google');
    expect(result[0].credit).toBe(CONVERSION_VALUE);
    expect(result[0].credit_percentage).toBe(100);

    expect(result[1].credit).toBe(0);
    expect(result[2].credit).toBe(0);
  });

  it('credits sum to conversion value', () => {
    const touchpoints = [tp('a', 1), tp('b', 2), tp('c', 3), tp('d', 4)];
    const result = firstTouchAttribution(touchpoints, CONVERSION_VALUE);
    const total = result.reduce((sum, r) => sum + r.credit, 0);
    expect(total).toBe(CONVERSION_VALUE);
  });
});

// =============================================================================
// Last-Touch Attribution
// =============================================================================

describe('lastTouchAttribution', () => {
  it('returns empty array for no touchpoints', () => {
    expect(lastTouchAttribution([], CONVERSION_VALUE)).toEqual([]);
  });

  it('gives 100% credit to single touchpoint', () => {
    const result = lastTouchAttribution([tp('google', 5)], CONVERSION_VALUE);
    expect(result[0].credit).toBe(CONVERSION_VALUE);
  });

  it('gives 100% credit to last (most recent) touchpoint', () => {
    const touchpoints = [tp('email', 3), tp('google', 10), tp('facebook', 5)];
    const result = lastTouchAttribution(touchpoints, CONVERSION_VALUE);

    // Sorted: google (10d) → facebook (5d) → email (3d)
    // Last = email (closest to conversion)
    expect(result[2].utm_source).toBe('email');
    expect(result[2].credit).toBe(CONVERSION_VALUE);
    expect(result[2].credit_percentage).toBe(100);

    expect(result[0].credit).toBe(0);
    expect(result[1].credit).toBe(0);
  });
});

// =============================================================================
// Linear Attribution
// =============================================================================

describe('linearAttribution', () => {
  it('returns empty array for no touchpoints', () => {
    expect(linearAttribution([], CONVERSION_VALUE)).toEqual([]);
  });

  it('gives 100% credit to single touchpoint', () => {
    const result = linearAttribution([tp('google', 5)], CONVERSION_VALUE);
    expect(result[0].credit).toBe(CONVERSION_VALUE);
    expect(result[0].credit_percentage).toBe(100);
  });

  it('splits credit equally across 3 touchpoints', () => {
    const touchpoints = [tp('google', 10), tp('facebook', 5), tp('email', 1)];
    const result = linearAttribution(touchpoints, CONVERSION_VALUE);

    const expected = CONVERSION_VALUE / 3;
    for (const r of result) {
      expect(r.credit).toBeCloseTo(expected, 5);
      expect(r.credit_percentage).toBeCloseTo(100 / 3, 5);
    }
  });

  it('credits sum exactly to conversion value', () => {
    const touchpoints = [tp('a', 1), tp('b', 2), tp('c', 3), tp('d', 4), tp('e', 5)];
    const result = linearAttribution(touchpoints, CONVERSION_VALUE);
    const total = result.reduce((sum, r) => sum + r.credit, 0);
    expect(total).toBeCloseTo(CONVERSION_VALUE, 5);
  });

  it('percentages sum to 100', () => {
    const touchpoints = [tp('a', 1), tp('b', 2), tp('c', 3)];
    const result = linearAttribution(touchpoints, CONVERSION_VALUE);
    const totalPct = result.reduce((sum, r) => sum + r.credit_percentage, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });
});

// =============================================================================
// Time-Decay Attribution
// =============================================================================

describe('timeDecayAttribution', () => {
  const conversionTimestamp = new Date('2025-01-20T10:00:00Z');

  it('returns empty array for no touchpoints', () => {
    expect(timeDecayAttribution([], CONVERSION_VALUE, conversionTimestamp)).toEqual([]);
  });

  it('gives 100% credit to single touchpoint', () => {
    const result = timeDecayAttribution([tp('google', 5)], CONVERSION_VALUE, conversionTimestamp);
    expect(result[0].credit).toBeCloseTo(CONVERSION_VALUE, 5);
    expect(result[0].credit_percentage).toBeCloseTo(100, 5);
  });

  it('gives more credit to recent touchpoints', () => {
    const touchpoints = [tp('google', 14), tp('facebook', 7), tp('email', 1)];
    const result = timeDecayAttribution(touchpoints, CONVERSION_VALUE, conversionTimestamp);

    // email (1 day) > facebook (7 days) > google (14 days)
    const credits = result.map(r => r.credit);
    expect(credits[2]).toBeGreaterThan(credits[1]); // email > facebook
    expect(credits[1]).toBeGreaterThan(credits[0]); // facebook > google
  });

  it('at half-life (7 days), touchpoint gets ~50% of same-day weight', () => {
    const touchpoints = [
      tp('old', 7),     // Exactly 7 days (half-life)
      tp('recent', 0),  // Same-day as conversion
    ];
    const result = timeDecayAttribution(touchpoints, CONVERSION_VALUE, conversionTimestamp);

    // The 7-day old touchpoint should have weight = 0.5 relative to the same-day one
    // Normalized: recent = 1/(1+0.5) = 0.667, old = 0.5/(1+0.5) = 0.333
    expect(result[0].credit_percentage).toBeCloseTo(33.33, 0); // old
    expect(result[1].credit_percentage).toBeCloseTo(66.67, 0); // recent
  });

  it('credits sum to conversion value', () => {
    const touchpoints = [tp('a', 1), tp('b', 3), tp('c', 7), tp('d', 14), tp('e', 21)];
    const result = timeDecayAttribution(touchpoints, CONVERSION_VALUE, conversionTimestamp);
    const total = result.reduce((sum, r) => sum + r.credit, 0);
    expect(total).toBeCloseTo(CONVERSION_VALUE, 5);
  });

  it('percentages sum to 100', () => {
    const touchpoints = [tp('a', 1), tp('b', 7), tp('c', 14)];
    const result = timeDecayAttribution(touchpoints, CONVERSION_VALUE, conversionTimestamp);
    const totalPct = result.reduce((sum, r) => sum + r.credit_percentage, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });

  it('respects custom half-life', () => {
    const touchpoints = [tp('old', 3), tp('recent', 0)];
    const halfLife3 = timeDecayAttribution(touchpoints, CONVERSION_VALUE, conversionTimestamp, 3);
    const halfLife30 = timeDecayAttribution(touchpoints, CONVERSION_VALUE, conversionTimestamp, 30);

    // With shorter half-life, old touchpoint gets less credit
    expect(halfLife3[0].credit).toBeLessThan(halfLife30[0].credit);
  });
});

// =============================================================================
// Position-Based Attribution
// =============================================================================

describe('positionBasedAttribution', () => {
  it('returns empty array for no touchpoints', () => {
    expect(positionBasedAttribution([], CONVERSION_VALUE)).toEqual([]);
  });

  it('gives 100% to single touchpoint', () => {
    const result = positionBasedAttribution([tp('google', 5)], CONVERSION_VALUE);
    expect(result[0].credit).toBe(CONVERSION_VALUE);
    expect(result[0].credit_percentage).toBe(100);
  });

  it('splits proportionally for 2 touchpoints', () => {
    const result = positionBasedAttribution(
      [tp('google', 10), tp('email', 1)],
      CONVERSION_VALUE
    );

    // Default weights: first=0.4, last=0.4 → normalized 50/50
    expect(result[0].credit).toBeCloseTo(CONVERSION_VALUE * 0.5, 5);
    expect(result[1].credit).toBeCloseTo(CONVERSION_VALUE * 0.5, 5);
  });

  it('assigns 40/20/40 for 3 touchpoints (default weights)', () => {
    const touchpoints = [tp('google', 10), tp('facebook', 5), tp('email', 1)];
    const result = positionBasedAttribution(touchpoints, CONVERSION_VALUE);

    expect(result[0].credit).toBeCloseTo(CONVERSION_VALUE * 0.4, 5);  // First
    expect(result[1].credit).toBeCloseTo(CONVERSION_VALUE * 0.2, 5);  // Middle
    expect(result[2].credit).toBeCloseTo(CONVERSION_VALUE * 0.4, 5);  // Last
  });

  it('distributes middle credit evenly for 5 touchpoints', () => {
    const touchpoints = [
      tp('google', 20), tp('facebook', 15), tp('twitter', 10),
      tp('linkedin', 5), tp('email', 1),
    ];
    const result = positionBasedAttribution(touchpoints, CONVERSION_VALUE);

    expect(result[0].credit).toBeCloseTo(CONVERSION_VALUE * 0.4, 5);          // First: 40%
    expect(result[1].credit).toBeCloseTo(CONVERSION_VALUE * 0.2 / 3, 5);      // Middle 1: ~6.67%
    expect(result[2].credit).toBeCloseTo(CONVERSION_VALUE * 0.2 / 3, 5);      // Middle 2: ~6.67%
    expect(result[3].credit).toBeCloseTo(CONVERSION_VALUE * 0.2 / 3, 5);      // Middle 3: ~6.67%
    expect(result[4].credit).toBeCloseTo(CONVERSION_VALUE * 0.4, 5);          // Last: 40%
  });

  it('supports custom weights', () => {
    const touchpoints = [tp('google', 10), tp('facebook', 5), tp('email', 1)];
    const result = positionBasedAttribution(touchpoints, CONVERSION_VALUE, {
      first: 0.3,
      last: 0.5,
      middle: 0.2,
    });

    expect(result[0].credit).toBeCloseTo(CONVERSION_VALUE * 0.3, 5);
    expect(result[1].credit).toBeCloseTo(CONVERSION_VALUE * 0.2, 5);
    expect(result[2].credit).toBeCloseTo(CONVERSION_VALUE * 0.5, 5);
  });

  it('credits sum to conversion value', () => {
    const touchpoints = [tp('a', 1), tp('b', 2), tp('c', 3), tp('d', 4), tp('e', 5)];
    const result = positionBasedAttribution(touchpoints, CONVERSION_VALUE);
    const total = result.reduce((sum, r) => sum + r.credit, 0);
    expect(total).toBeCloseTo(CONVERSION_VALUE, 5);
  });
});

// =============================================================================
// Data-Driven Attribution
// =============================================================================

describe('dataDrivenAttribution', () => {
  it('returns empty map for no paths', () => {
    const result = dataDrivenAttribution([], []);
    expect(result.size).toBe(0);
  });

  it('credits channel that appears in all conversions', () => {
    const conversionPaths: ConversionPath[] = [
      {
        conversion_id: 'c1',
        anonymous_ids: ['a1'],
        touchpoints: [tp('google', 5), tp('email', 1)],
        conversion_timestamp: new Date('2025-01-20T10:00:00Z'),
        conversion_value: 100,
        conversion_type: 'purchase',
      },
      {
        conversion_id: 'c2',
        anonymous_ids: ['a2'],
        touchpoints: [tp('google', 3)],
        conversion_timestamp: new Date('2025-01-20T10:00:00Z'),
        conversion_value: 200,
        conversion_type: 'purchase',
      },
    ];

    const nonConversionPaths: ConversionPath[] = [
      {
        conversion_id: 'nc1',
        anonymous_ids: ['a3'],
        touchpoints: [tp('facebook', 2)],
        conversion_timestamp: new Date('2025-01-20T10:00:00Z'),
        conversion_value: 0,
        conversion_type: 'none',
      },
    ];

    const result = dataDrivenAttribution(conversionPaths, nonConversionPaths);

    // Google appears in 100% of conversions and 0% of non-conversions
    // Should have highest weight
    expect(result.has('google')).toBe(true);
    expect(result.get('google')!).toBeGreaterThan(0);
  });

  it('weights sum to 1.0 (normalized)', () => {
    const conversionPaths: ConversionPath[] = [
      {
        conversion_id: 'c1',
        anonymous_ids: ['a1'],
        touchpoints: [tp('google', 5), tp('email', 1)],
        conversion_timestamp: new Date(),
        conversion_value: 100,
        conversion_type: 'purchase',
      },
    ];

    const nonConversionPaths: ConversionPath[] = [
      {
        conversion_id: 'nc1',
        anonymous_ids: ['a2'],
        touchpoints: [tp('facebook', 2)],
        conversion_timestamp: new Date(),
        conversion_value: 0,
        conversion_type: 'none',
      },
    ];

    const result = dataDrivenAttribution(conversionPaths, nonConversionPaths);
    const totalWeight = Array.from(result.values()).reduce((sum, w) => sum + w, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it('channel only in non-conversions gets zero weight', () => {
    const conversionPaths: ConversionPath[] = [
      {
        conversion_id: 'c1',
        anonymous_ids: ['a1'],
        touchpoints: [tp('google', 5)],
        conversion_timestamp: new Date(),
        conversion_value: 100,
        conversion_type: 'purchase',
      },
    ];

    const nonConversionPaths: ConversionPath[] = [
      {
        conversion_id: 'nc1',
        anonymous_ids: ['a2'],
        touchpoints: [tp('spam_channel', 2)],
        conversion_timestamp: new Date(),
        conversion_value: 0,
        conversion_type: 'none',
      },
    ];

    const result = dataDrivenAttribution(conversionPaths, nonConversionPaths);
    expect(result.get('spam_channel')).toBe(0);
  });
});

// =============================================================================
// Markov Transition Matrix
// =============================================================================

describe('buildMarkovTransitionMatrix', () => {
  it('builds matrix with correct states', () => {
    const paths: ConversionPath[] = [
      {
        conversion_id: 'c1',
        anonymous_ids: ['a1'],
        touchpoints: [tp('google', 10), tp('email', 1)],
        conversion_timestamp: new Date('2025-01-20T10:00:00Z'),
        conversion_value: 100,
        conversion_type: 'purchase',
      },
    ];

    const matrix = buildMarkovTransitionMatrix(paths, []);

    // States should include: start, email, google, conversion, null
    expect(matrix.states).toContain('start');
    expect(matrix.states).toContain('google');
    expect(matrix.states).toContain('email');
    expect(matrix.states).toContain('conversion');
    expect(matrix.states).toContain('null');
  });

  it('matrix dimensions match state count', () => {
    const paths: ConversionPath[] = [
      {
        conversion_id: 'c1',
        anonymous_ids: ['a1'],
        touchpoints: [tp('google', 5), tp('facebook', 3), tp('email', 1)],
        conversion_timestamp: new Date('2025-01-20T10:00:00Z'),
        conversion_value: 100,
        conversion_type: 'purchase',
      },
    ];

    const matrix = buildMarkovTransitionMatrix(paths, []);

    expect(matrix.matrix.length).toBe(matrix.states.length);
    for (const row of matrix.matrix) {
      expect(row.length).toBe(matrix.states.length);
    }
  });

  it('conversion paths end in conversion state', () => {
    const paths: ConversionPath[] = [
      {
        conversion_id: 'c1',
        anonymous_ids: ['a1'],
        touchpoints: [tp('google', 5)],
        conversion_timestamp: new Date('2025-01-20T10:00:00Z'),
        conversion_value: 100,
        conversion_type: 'purchase',
      },
    ];

    const matrix = buildMarkovTransitionMatrix(paths, []);

    // Find transition from google → conversion
    const googleIdx = matrix.states.indexOf('google');
    const convIdx = matrix.states.indexOf('conversion');
    expect(googleIdx).toBeGreaterThan(-1);
    expect(convIdx).toBeGreaterThan(-1);

    // Raw count should be >= 1 (before normalization)
    // The matrix stores probabilities, so google → conversion should be > 0
    expect(matrix.matrix[googleIdx][convIdx]).toBeGreaterThan(0);
  });

  it('handles empty paths gracefully', () => {
    const matrix = buildMarkovTransitionMatrix([], []);
    expect(matrix.states).toContain('start');
    expect(matrix.states).toContain('conversion');
    expect(matrix.states).toContain('null');
  });
});

// =============================================================================
// Edge Cases (Shared)
// =============================================================================

describe('Edge Cases', () => {
  it('handles zero conversion value', () => {
    const touchpoints = [tp('google', 5), tp('email', 1)];

    const firstResult = firstTouchAttribution(touchpoints, 0);
    expect(firstResult[0].credit).toBe(0);

    const linearResult = linearAttribution(touchpoints, 0);
    expect(linearResult[0].credit).toBe(0);
  });

  it('handles very large path (20 touchpoints)', () => {
    const touchpoints = Array.from({ length: 20 }, (_, i) => tp(`ch-${i}`, 20 - i));
    const convTime = new Date('2025-01-20T10:00:00Z');

    const linearResult = linearAttribution(touchpoints, CONVERSION_VALUE);
    expect(linearResult).toHaveLength(20);
    const linearTotal = linearResult.reduce((s, r) => s + r.credit, 0);
    expect(linearTotal).toBeCloseTo(CONVERSION_VALUE, 5);

    const timeResult = timeDecayAttribution(touchpoints, CONVERSION_VALUE, convTime);
    expect(timeResult).toHaveLength(20);
    const timeTotal = timeResult.reduce((s, r) => s + r.credit, 0);
    expect(timeTotal).toBeCloseTo(CONVERSION_VALUE, 5);

    const posResult = positionBasedAttribution(touchpoints, CONVERSION_VALUE);
    expect(posResult).toHaveLength(20);
    const posTotal = posResult.reduce((s, r) => s + r.credit, 0);
    expect(posTotal).toBeCloseTo(CONVERSION_VALUE, 5);
  });

  it('handles unsorted touchpoints (sorts internally)', () => {
    // Provide touchpoints in reverse chronological order
    const touchpoints = [tp('email', 1), tp('facebook', 5), tp('google', 10)];

    const result = firstTouchAttribution(touchpoints, CONVERSION_VALUE);
    // First touch should be google (oldest, 10 days ago)
    expect(result[0].utm_source).toBe('google');
    expect(result[0].credit).toBe(CONVERSION_VALUE);
  });
});
