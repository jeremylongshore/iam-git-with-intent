/**
 * SDLC Events Module Tests
 *
 * EPIC 002: SDLC Telemetry + Bottleneck Measurement
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  emitSDLCEvent,
  onSDLCEvent,
  startStageTimer,
  withStageTracking,
  workflowToStage,
  inferStageFromContext,
  getSDLCMetrics,
  type SDLCEvent,
  type SDLCStage,
} from '../sdlc-events.js';
import { InMemorySDLCEventStore, setSDLCEventStore } from '../sdlc-event-store.js';

describe('sdlc-events', () => {
  let store: InMemorySDLCEventStore;

  beforeEach(() => {
    store = new InMemorySDLCEventStore();
    setSDLCEventStore(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('emitSDLCEvent', () => {
    it('should emit a valid event with all required fields', () => {
      const event = emitSDLCEvent({
        stage: 'coding',
        action: 'started',
        runId: 'test-run-123',
      });

      expect(event.eventId).toBeDefined();
      expect(event.stage).toBe('coding');
      expect(event.action).toBe('started');
      expect(event.runId).toBe('test-run-123');
      expect(event.timestamp).toBeDefined();
      expect(event.tenantId).toBeDefined();
    });

    it('should include optional fields when provided', () => {
      const event = emitSDLCEvent({
        stage: 'review',
        action: 'completed',
        durationMs: 5000,
        prNumber: 42,
        repository: 'owner/repo',
        agentId: 'reviewer',
        workflowType: 'review',
        metadata: { files: 5 },
      });

      expect(event.durationMs).toBe(5000);
      expect(event.prNumber).toBe(42);
      expect(event.repository).toBe('owner/repo');
      expect(event.agentId).toBe('reviewer');
      expect(event.workflowType).toBe('review');
      expect(event.metadata).toEqual({ files: 5 });
    });

    it('should record metrics when emitting events', () => {
      const metrics = getSDLCMetrics();
      const initialCount = metrics.eventsTotal.get({ stage: 'testing', action: 'started', tenant_id: 'default' });

      emitSDLCEvent({ stage: 'testing', action: 'started' });

      const newCount = metrics.eventsTotal.get({ stage: 'testing', action: 'started', tenant_id: 'default' });
      expect(newCount).toBe(initialCount + 1);
    });
  });

  describe('onSDLCEvent', () => {
    it('should call listeners when events are emitted', () => {
      const listener = vi.fn();
      const unsubscribe = onSDLCEvent(listener);

      emitSDLCEvent({ stage: 'coding', action: 'started' });

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as SDLCEvent;
      expect(event.stage).toBe('coding');
      expect(event.action).toBe('started');

      unsubscribe();
    });

    it('should stop calling listener after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = onSDLCEvent(listener);

      emitSDLCEvent({ stage: 'coding', action: 'started' });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      emitSDLCEvent({ stage: 'coding', action: 'completed' });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('startStageTimer', () => {
    it('should emit started event immediately', () => {
      const listener = vi.fn();
      onSDLCEvent(listener);

      startStageTimer('coding', { runId: 'test-123' });

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as SDLCEvent;
      expect(event.action).toBe('started');
      expect(event.stage).toBe('coding');
    });

    it('should emit completed event with duration when stopped', async () => {
      const listener = vi.fn();
      onSDLCEvent(listener);

      const timer = startStageTimer('review');

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 50));

      const event = timer.stop('completed');

      expect(listener).toHaveBeenCalledTimes(2);
      expect(event.action).toBe('completed');
      // setTimeout may fire slightly early against Date.now() truncation.
      expect(event.durationMs).toBeGreaterThanOrEqual(45);
    });

    it('should emit failed event with error details', () => {
      const timer = startStageTimer('testing');
      const event = timer.stop('failed', {
        errorType: 'TestError',
        errorMessage: 'Tests failed',
      });

      expect(event.action).toBe('failed');
      expect(event.errorType).toBe('TestError');
      expect(event.errorMessage).toBe('Tests failed');
    });
  });

  describe('withStageTracking', () => {
    it('should track successful async operations', async () => {
      const listener = vi.fn();
      onSDLCEvent(listener);

      const result = await withStageTracking('coding', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'success';
      });

      expect(result).toBe('success');
      expect(listener).toHaveBeenCalledTimes(2);

      const completedEvent = listener.mock.calls[1][0] as SDLCEvent;
      expect(completedEvent.action).toBe('completed');
    });

    it('should track failed async operations', async () => {
      const listener = vi.fn();
      onSDLCEvent(listener);

      await expect(
        withStageTracking('testing', async () => {
          throw new Error('Test failed');
        })
      ).rejects.toThrow('Test failed');

      expect(listener).toHaveBeenCalledTimes(2);

      const failedEvent = listener.mock.calls[1][0] as SDLCEvent;
      expect(failedEvent.action).toBe('failed');
      expect(failedEvent.errorType).toBe('Error');
      expect(failedEvent.errorMessage).toBe('Test failed');
    });
  });

  describe('workflowToStage', () => {
    const cases: [string, SDLCStage][] = [
      ['triage', 'planning'],
      ['issue-to-code', 'coding'],
      ['generate', 'coding'],
      ['coder', 'coding'],
      ['review', 'review'],
      ['reviewer', 'review'],
      ['resolve', 'coding'],
      ['merge', 'release'],
      ['deploy', 'release'],
      ['release', 'release'],
      ['test', 'testing'],
      ['init', 'onboarding'],
      ['diagnose', 'incident'],
      ['forensics', 'incident'],
      ['unknown', 'coding'], // Default
    ];

    it.each(cases)('should map %s to %s', (workflow, expectedStage) => {
      expect(workflowToStage(workflow)).toBe(expectedStage);
    });
  });

  describe('inferStageFromContext', () => {
    it('should return incident stage for incidents', () => {
      expect(inferStageFromContext({ isIncident: true })).toBe('incident');
    });

    it('should return onboarding stage for new setups', () => {
      expect(inferStageFromContext({ isNewSetup: true })).toBe('onboarding');
    });

    it('should return review stage for reviews', () => {
      expect(inferStageFromContext({ isReview: true })).toBe('review');
    });

    it('should return coding stage for merge conflicts', () => {
      expect(inferStageFromContext({ hasMergeConflicts: true })).toBe('coding');
    });

    it('should return release stage for merged PRs', () => {
      expect(inferStageFromContext({ isPRMerged: true })).toBe('release');
    });

    it('should default to coding stage', () => {
      expect(inferStageFromContext({})).toBe('coding');
    });
  });
});

describe('InMemorySDLCEventStore', () => {
  let store: InMemorySDLCEventStore;

  beforeEach(() => {
    store = new InMemorySDLCEventStore({ maxEvents: 100 });
  });

  describe('store and query', () => {
    it('should store and retrieve events', async () => {
      const event = emitSDLCEvent({
        stage: 'coding',
        action: 'completed',
        durationMs: 1000,
      });

      await store.store(event);

      const results = await store.query({});
      expect(results.length).toBe(1);
      expect(results[0].eventId).toBe(event.eventId);
    });

    it('should filter by stage', async () => {
      await store.store(emitSDLCEvent({ stage: 'coding', action: 'started' }));
      await store.store(emitSDLCEvent({ stage: 'review', action: 'started' }));
      await store.store(emitSDLCEvent({ stage: 'coding', action: 'completed' }));

      const results = await store.query({ stage: 'coding' });
      expect(results.length).toBe(2);
      expect(results.every((e) => e.stage === 'coding')).toBe(true);
    });

    it('should filter by action', async () => {
      await store.store(emitSDLCEvent({ stage: 'coding', action: 'started' }));
      await store.store(emitSDLCEvent({ stage: 'coding', action: 'completed', durationMs: 1000 }));

      const results = await store.query({ action: 'completed' });
      expect(results.length).toBe(1);
      expect(results[0].action).toBe('completed');
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 10; i++) {
        await store.store(emitSDLCEvent({ stage: 'coding', action: 'started' }));
      }

      const results = await store.query({ limit: 5 });
      expect(results.length).toBe(5);
    });

    it('should enforce max events (FIFO)', async () => {
      const smallStore = new InMemorySDLCEventStore({ maxEvents: 3 });

      for (let i = 0; i < 5; i++) {
        await smallStore.store(
          emitSDLCEvent({ stage: 'coding', action: 'started', metadata: { index: i } })
        );
      }

      const results = await smallStore.query({});
      expect(results.length).toBe(3);
      // Should have the last 3 events (2, 3, 4) - order may vary due to same-millisecond timestamps
      const indices = results.map((e) => (e.metadata as { index: number }).index).sort((a, b) => a - b);
      expect(indices).toEqual([2, 3, 4]);
    });
  });

  describe('getStageTimings', () => {
    it('should calculate stage timing aggregations', async () => {
      // Add completed events with durations
      await store.store(
        emitSDLCEvent({ stage: 'coding', action: 'completed', durationMs: 1000 })
      );
      await store.store(
        emitSDLCEvent({ stage: 'coding', action: 'completed', durationMs: 2000 })
      );
      await store.store(
        emitSDLCEvent({ stage: 'coding', action: 'completed', durationMs: 3000 })
      );
      await store.store(
        emitSDLCEvent({ stage: 'coding', action: 'failed', durationMs: 500, errorType: 'TestError' })
      );

      const timings = await store.getStageTimings({});

      expect(timings.length).toBe(1);
      const codingTiming = timings[0];
      expect(codingTiming.stage).toBe('coding');
      expect(codingTiming.count).toBe(4);
      expect(codingTiming.completedCount).toBe(3);
      expect(codingTiming.failedCount).toBe(1);
      expect(codingTiming.avgDurationMs).toBeGreaterThan(0);
    });

    it('should filter by date range', async () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const recentEvent = emitSDLCEvent({ stage: 'coding', action: 'completed', durationMs: 1000 });

      await store.store({
        ...emitSDLCEvent({ stage: 'coding', action: 'completed', durationMs: 2000 }),
        timestamp: oldDate.toISOString(),
      });
      await store.store(recentEvent);

      const timings = await store.getStageTimings({
        since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
      });

      expect(timings.length).toBe(1);
      expect(timings[0].count).toBe(1);
    });
  });
});
