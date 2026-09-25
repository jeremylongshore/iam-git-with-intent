/**
 * SLO Module Tests (A12)
 *
 * Tests for SLO definitions and calculations.
 */

import { describe, it, expect } from 'vitest';
import {
  SLO_DEFINITIONS,
  LATENCY_TARGETS,
  getSLOById,
  getSLOsByService,
  getSLOsByCategory,
  getSLOsByTag,
  getCriticalSLOs,
  calculateErrorBudgetMinutes,
  windowToMinutes,
  calculateBurnRate,
  determineSLOStatus,
  calculateSLOStatus,
  getLatencyThresholds,
} from '../index.js';

// =============================================================================
// SLO Definitions Tests
// =============================================================================

describe('SLO Definitions', () => {
  it('has all required SLO definitions', () => {
    expect(SLO_DEFINITIONS.length).toBeGreaterThanOrEqual(10);
  });

  it('has API availability SLO', () => {
    const slo = getSLOById('api-availability');
    expect(slo).toBeDefined();
    expect(slo?.target).toBe(99.9);
    expect(slo?.category).toBe('availability');
  });

  it('has gateway availability SLO', () => {
    const slo = getSLOById('gateway-availability');
    expect(slo).toBeDefined();
    expect(slo?.target).toBe(99.9);
  });

  it('has API latency SLOs', () => {
    const p95 = getSLOById('api-latency-p95');
    const p99 = getSLOById('api-latency-p99');
    expect(p95).toBeDefined();
    expect(p99).toBeDefined();
    expect(p95?.category).toBe('latency');
  });

  it('has worker SLOs', () => {
    const slos = getSLOsByService('worker');
    expect(slos.length).toBeGreaterThanOrEqual(2);
  });

  it('has run completion rate SLO', () => {
    const slo = getSLOById('run-completion-rate');
    expect(slo).toBeDefined();
    expect(slo?.target).toBe(95);
  });

  it('all SLOs have required fields', () => {
    for (const slo of SLO_DEFINITIONS) {
      expect(slo.id).toBeDefined();
      expect(slo.name).toBeDefined();
      expect(slo.description).toBeDefined();
      expect(slo.category).toBeDefined();
      expect(slo.target).toBeGreaterThan(0);
      expect(slo.target).toBeLessThanOrEqual(100);
      expect(slo.window).toBeDefined();
      expect(slo.service).toBeDefined();
      expect(slo.goodQuery).toBeDefined();
      expect(slo.totalQuery).toBeDefined();
    }
  });
});

// =============================================================================
// Latency Targets Tests
// =============================================================================

describe('Latency Targets', () => {
  it('has API latency targets', () => {
    expect(LATENCY_TARGETS.api).toBeDefined();
    expect(LATENCY_TARGETS.api.healthCheck).toBeDefined();
    expect(LATENCY_TARGETS.api.healthCheck.p99).toBeLessThan(1000);
  });

  it('has gateway latency targets', () => {
    expect(LATENCY_TARGETS.gateway).toBeDefined();
    expect(LATENCY_TARGETS.gateway.taskSubmit.p95).toBeLessThan(5000);
  });

  it('has worker latency targets', () => {
    expect(LATENCY_TARGETS.worker).toBeDefined();
    expect(LATENCY_TARGETS.worker.triage.p95).toBeDefined();
    expect(LATENCY_TARGETS.worker.plan.p95).toBeDefined();
    expect(LATENCY_TARGETS.worker.resolve.p95).toBeDefined();
    expect(LATENCY_TARGETS.worker.review.p95).toBeDefined();
  });

  it('has storage latency targets', () => {
    expect(LATENCY_TARGETS.storage).toBeDefined();
    expect(LATENCY_TARGETS.storage.firestoreRead.p99).toBeLessThan(1000);
    expect(LATENCY_TARGETS.storage.gcsUpload.p95).toBeLessThan(5000);
  });

  it('getLatencyThresholds returns correct values', () => {
    const apiHealth = getLatencyThresholds('api', 'healthCheck');
    expect(apiHealth).toEqual({ p50: 10, p95: 50, p99: 100 });

    const workerTriage = getLatencyThresholds('worker', 'triage');
    expect(workerTriage).toEqual({ p50: 5000, p95: 15000, p99: 30000 });
  });

  it('getLatencyThresholds returns undefined for unknown operation', () => {
    const result = getLatencyThresholds('api', 'nonexistent');
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// Query Helpers Tests
// =============================================================================

describe('Query Helpers', () => {
  describe('getSLOById', () => {
    it('finds existing SLO', () => {
      const slo = getSLOById('api-availability');
      expect(slo).toBeDefined();
      expect(slo?.id).toBe('api-availability');
    });

    it('returns undefined for unknown ID', () => {
      const slo = getSLOById('nonexistent');
      expect(slo).toBeUndefined();
    });
  });

  describe('getSLOsByService', () => {
    it('finds SLOs by service', () => {
      const apiSLOs = getSLOsByService('api');
      expect(apiSLOs.length).toBeGreaterThanOrEqual(2);
      expect(apiSLOs.every((s) => s.service === 'api')).toBe(true);
    });

    it('returns empty array for unknown service', () => {
      const slos = getSLOsByService('unknown');
      expect(slos).toEqual([]);
    });
  });

  describe('getSLOsByCategory', () => {
    it('finds availability SLOs', () => {
      const slos = getSLOsByCategory('availability');
      expect(slos.length).toBeGreaterThanOrEqual(2);
      expect(slos.every((s) => s.category === 'availability')).toBe(true);
    });

    it('finds latency SLOs', () => {
      const slos = getSLOsByCategory('latency');
      expect(slos.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('getSLOsByTag', () => {
    it('finds critical SLOs', () => {
      const slos = getSLOsByTag('critical');
      expect(slos.length).toBeGreaterThanOrEqual(1);
    });

    it('finds performance SLOs', () => {
      const slos = getSLOsByTag('performance');
      expect(slos.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getCriticalSLOs', () => {
    it('returns critical and SLA SLOs', () => {
      const slos = getCriticalSLOs();
      expect(slos.length).toBeGreaterThanOrEqual(2);
      expect(
        slos.every((s) => s.tags?.includes('critical') || s.tags?.includes('sla'))
      ).toBe(true);
    });
  });
});

// =============================================================================
// Calculation Tests
// =============================================================================

describe('Error Budget Calculations', () => {
  describe('windowToMinutes', () => {
    it('converts windows correctly', () => {
      expect(windowToMinutes('1h')).toBe(60);
      expect(windowToMinutes('24h')).toBe(24 * 60);
      expect(windowToMinutes('7d')).toBe(7 * 24 * 60);
      expect(windowToMinutes('28d')).toBe(28 * 24 * 60);
      expect(windowToMinutes('30d')).toBe(30 * 24 * 60);
      expect(windowToMinutes('90d')).toBe(90 * 24 * 60);
    });
  });

  describe('calculateErrorBudgetMinutes', () => {
    it('calculates error budget for 99.9% SLO over 30 days', () => {
      const windowMinutes = 30 * 24 * 60; // 43200 minutes
      const errorBudget = calculateErrorBudgetMinutes(99.9, windowMinutes);
      expect(errorBudget).toBeCloseTo(43.2, 1); // 0.1% of 30 days = 43.2 minutes
    });

    it('calculates error budget for 99% SLO over 7 days', () => {
      const windowMinutes = 7 * 24 * 60; // 10080 minutes
      const errorBudget = calculateErrorBudgetMinutes(99, windowMinutes);
      expect(errorBudget).toBeCloseTo(100.8, 1); // 1% of 7 days = 100.8 minutes
    });

    it('calculates error budget for 95% SLO', () => {
      const windowMinutes = 24 * 60; // 1440 minutes (1 day)
      const errorBudget = calculateErrorBudgetMinutes(95, windowMinutes);
      expect(errorBudget).toBe(72); // 5% of 1 day = 72 minutes
    });
  });

  describe('calculateBurnRate', () => {
    it('returns 0 when current is at or above target', () => {
      expect(calculateBurnRate(99.9, 99.9)).toBe(0);
      expect(calculateBurnRate(100, 99.9)).toBe(0);
    });

    it('returns 1 when consuming at exactly budget rate', () => {
      // 99% target, 98% current = using 1% of 1% budget = burn rate 1
      const burnRate = calculateBurnRate(98, 99);
      expect(burnRate).toBe(1);
    });

    it('returns > 1 when consuming faster than budget', () => {
      // 99% target, 97% current = using 2% of 1% budget = burn rate 2
      const burnRate = calculateBurnRate(97, 99);
      expect(burnRate).toBe(2);
    });

    it('returns 10 when burning at 10x rate', () => {
      // 99% target, 89% current = using 10% of 1% budget = burn rate 10
      const burnRate = calculateBurnRate(89, 99);
      expect(burnRate).toBe(10);
    });
  });

  describe('determineSLOStatus', () => {
    it('returns met when current >= target', () => {
      expect(determineSLOStatus(99.95, 99.9, 0)).toBe('met');
      expect(determineSLOStatus(100, 99.9, 0)).toBe('met');
    });

    it('returns at_risk when slightly below target with high burn rate', () => {
      // 99.9 target, 99.5 current (>95% of target), burn rate > 1
      expect(determineSLOStatus(99.5, 99.9, 2)).toBe('at_risk');
    });

    it('returns breached when significantly below target', () => {
      // When below 95% of target, always breached
      expect(determineSLOStatus(90, 99.9, 5)).toBe('breached');
    });
  });
});

// =============================================================================
// SLO Status Calculation Tests
// =============================================================================

describe('calculateSLOStatus', () => {
  const testSLO = {
    id: 'test-slo',
    name: 'Test SLO',
    description: 'Test SLO for unit tests',
    category: 'availability' as const,
    target: 99.9,
    window: '30d' as const,
    service: 'test',
    goodQuery: 'test',
    totalQuery: 'test',
  };

  it('calculates status when SLO is met', () => {
    const status = calculateSLOStatus(testSLO, 9999, 10000);
    expect(status.sloId).toBe('test-slo');
    expect(status.sloName).toBe('Test SLO');
    expect(status.target).toBe(99.9);
    expect(status.current).toBe(99.99);
    expect(status.status).toBe('met');
    expect(status.errorBudget).toBeCloseTo(0.1, 1);
    expect(status.errorBudgetRemaining).toBeGreaterThan(0);
  });

  it('calculates status when SLO is breached', () => {
    // 9000/10000 = 90% - well below 99.9%
    const status = calculateSLOStatus(testSLO, 9000, 10000);
    expect(status.current).toBe(90);
    expect(status.status).toBe('breached');
    expect(status.errorBudgetRemaining).toBe(0);
    expect(status.burnRate).toBeGreaterThan(1);
  });

  it('handles zero total count', () => {
    const status = calculateSLOStatus(testSLO, 0, 0);
    expect(status.current).toBe(100);
    expect(status.status).toBe('met');
  });

  it('includes timestamp', () => {
    const status = calculateSLOStatus(testSLO, 999, 1000);
    expect(status.calculatedAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// Performance Tests (Baseline Measurements)
// =============================================================================

describe('Performance Baselines', () => {
  // Wall-clock ceilings. 100ms flaked (105ms, 303ms) when turbo runs every
  // package's tests in parallel on a shared runner; 1000ms still catches an
  // order-of-magnitude regression without failing on scheduler noise.
  const PERF_CEILING_MS = 1000;

  it('SLO lookup is fast (< 1ms)', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      getSLOById('api-availability');
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PERF_CEILING_MS); // 1000 iterations in < 100ms = < 0.1ms per call
  });

  it('error budget calculation is fast (< 0.1ms)', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      calculateErrorBudgetMinutes(99.9, 43200);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PERF_CEILING_MS); // 10000 iterations in < 100ms
  });

  it('burn rate calculation is fast (< 0.1ms)', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      calculateBurnRate(99.5, 99.9);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PERF_CEILING_MS);
  });

  it('SLO status calculation is fast (< 0.1ms)', () => {
    const slo = getSLOById('api-availability')!;
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      calculateSLOStatus(slo, 9999, 10000);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(PERF_CEILING_MS);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('SLO Integration', () => {
  it('can calculate status for all SLOs', () => {
    for (const slo of SLO_DEFINITIONS) {
      const status = calculateSLOStatus(slo, 999, 1000);
      expect(status.sloId).toBe(slo.id);
      expect(status.target).toBe(slo.target);
      expect(['met', 'at_risk', 'breached']).toContain(status.status);
    }
  });

  it('all availability SLOs have 99.9% target', () => {
    const availabilitySLOs = getSLOsByCategory('availability');
    for (const slo of availabilitySLOs) {
      expect(slo.target).toBe(99.9);
    }
  });

  it('all SLOs have valid alert thresholds', () => {
    for (const slo of SLO_DEFINITIONS) {
      if (slo.alerts) {
        expect(slo.alerts.warningBurnRate).toBeGreaterThan(0);
        expect(slo.alerts.criticalBurnRate).toBeGreaterThan(slo.alerts.warningBurnRate);
      }
    }
  });

  it('latency targets have p50 < p95 < p99', () => {
    for (const [_service, operations] of Object.entries(LATENCY_TARGETS)) {
      for (const [_op, targets] of Object.entries(operations)) {
        const t = targets as { p50: number; p95: number; p99: number };
        expect(t.p50).toBeLessThan(t.p95);
        expect(t.p95).toBeLessThan(t.p99);
      }
    }
  });
});
