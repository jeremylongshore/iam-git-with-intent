/**
 * Reliability Module Tests
 *
 * Phase 7: Tests for locking, idempotency, errors, and observability.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  // Locking
  MemoryRunLockManager,
  getRunLockManager,
  setRunLockManager,
} from '../locking.js';

import {
  // Idempotency
  MemoryIdempotencyStore,
  generateIdempotencyKey,
  hashInput,
  createIdempotencyKey,
  getIdempotencyStore,
  setIdempotencyStore,
} from '../idempotency.js';

import {
  // Errors
  GwiError,
  RetryableError,
  NonRetryableError,
  PolicyDeniedError,
  ApprovalRequiredError,
  LockConflictError,
  TimeoutError,
  ValidationError,
  isRetryable,
  toExitCode,
  toAuditEvent,
} from '../errors.js';

import {
  // Observability
  Logger,
  getLogger,
  createTraceContext,
  DefaultMetricsRegistry,
  getMetricsRegistry,
  setMetricsRegistry,
} from '../observability.js';

import {
  // Resume
  CheckpointManager,
  analyzeResumePoint,
  shouldSkipStep,
  mergeArtifacts,
} from '../resume.js';

import type { SaaSRun, RunStep } from '../../storage/interfaces.js';

// =============================================================================
// Run Locking Tests
// =============================================================================

describe('Run Locking', () => {
  let lockManager: MemoryRunLockManager;

  beforeEach(() => {
    lockManager = new MemoryRunLockManager();
    setRunLockManager(lockManager);
  });

  describe('tryAcquire', () => {
    it('should acquire lock on unlocked run', async () => {
      const result = await lockManager.tryAcquire('run-123');

      expect(result.acquired).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock?.runId).toBe('run-123');
      expect(result.lock?.holderId).toMatch(/^holder-/);
    });

    it('should fail to acquire lock on already locked run', async () => {
      await lockManager.tryAcquire('run-123');
      const result = await lockManager.tryAcquire('run-123');

      expect(result.acquired).toBe(false);
      expect(result.error).toContain('locked');
      expect(result.existingHolderId).toBeDefined();
    });

    it('should acquire expired lock', async () => {
      await lockManager.tryAcquire('run-123', { ttlMs: 1 });
      await new Promise(r => setTimeout(r, 10));

      const result = await lockManager.tryAcquire('run-123');
      expect(result.acquired).toBe(true);
    });
  });

  describe('release', () => {
    it('should release held lock', async () => {
      const { lock } = await lockManager.tryAcquire('run-123');
      const released = await lockManager.release('run-123', lock!.holderId);

      expect(released).toBe(true);
      expect(await lockManager.getLock('run-123')).toBeNull();
    });

    it('should fail to release with wrong holder ID', async () => {
      await lockManager.tryAcquire('run-123');
      const released = await lockManager.release('run-123', 'wrong-holder');

      expect(released).toBe(false);
    });
  });

  describe('withLock', () => {
    it('should execute function with lock held', async () => {
      let executedWithLock = false;

      await lockManager.withLock('run-123', async (lock) => {
        executedWithLock = true;
        const current = await lockManager.getLock('run-123');
        expect(current?.holderId).toBe(lock.holderId);
      });

      expect(executedWithLock).toBe(true);
      expect(await lockManager.getLock('run-123')).toBeNull();
    });

    it('should release lock even if function throws', async () => {
      try {
        await lockManager.withLock('run-123', async () => {
          throw new Error('Test error');
        });
      } catch {
        // Expected
      }

      expect(await lockManager.getLock('run-123')).toBeNull();
    });
  });

  describe('extend', () => {
    it('should extend lock TTL', async () => {
      const { lock } = await lockManager.tryAcquire('run-123', { ttlMs: 1000 });
      const originalExpiry = lock!.expiresAt;

      const extended = await lockManager.extend('run-123', lock!.holderId, 5000);

      expect(extended).toBe(true);
      const updated = await lockManager.getLock('run-123');
      expect(updated!.expiresAt.getTime()).toBeGreaterThan(originalExpiry.getTime());
    });
  });

  describe('listLocks', () => {
    it('should list all active locks', async () => {
      await lockManager.tryAcquire('run-1');
      await lockManager.tryAcquire('run-2');
      await lockManager.tryAcquire('run-3');

      const locks = await lockManager.listLocks();
      expect(locks).toHaveLength(3);
    });
  });
});

// =============================================================================
// Idempotency Tests
// =============================================================================

describe('Idempotency', () => {
  let store: MemoryIdempotencyStore;

  beforeEach(() => {
    store = new MemoryIdempotencyStore();
    setIdempotencyStore(store);
  });

  describe('generateIdempotencyKey', () => {
    it('should generate deterministic key', () => {
      const key1 = generateIdempotencyKey({
        runId: 'run-123',
        stepId: 'step-1',
        operation: 'tool.invoke',
        inputHash: 'abc123',
      });

      const key2 = generateIdempotencyKey({
        runId: 'run-123',
        stepId: 'step-1',
        operation: 'tool.invoke',
        inputHash: 'abc123',
      });

      expect(key1).toBe(key2);
      expect(key1).toContain('run-123');
      expect(key1).toContain('step-1');
      expect(key1).toContain('tool.invoke');
    });
  });

  describe('hashInput', () => {
    it('should produce consistent hash for same input', () => {
      const hash1 = hashInput({ a: 1, b: 2 });
      const hash2 = hashInput({ b: 2, a: 1 }); // Different order

      expect(hash1).toBe(hash2); // Should be same due to key sorting
    });
  });

  describe('create and get', () => {
    it('should create pending record', async () => {
      const components = createIdempotencyKey('run-123', 'step-1', 'test', { x: 1 });
      const key = generateIdempotencyKey(components);

      const { record, created } = await store.create(key, components);

      expect(created).toBe(true);
      expect(record.status).toBe('pending');
      expect(record.keyComponents.runId).toBe('run-123');
    });

    it('should return existing record on duplicate create', async () => {
      const components = createIdempotencyKey('run-123', 'step-1', 'test', { x: 1 });
      const key = generateIdempotencyKey(components);

      await store.create(key, components);
      const { created } = await store.create(key, components);

      expect(created).toBe(false);
    });
  });

  describe('complete and fail', () => {
    it('should complete record with result', async () => {
      const components = createIdempotencyKey('run-123', 'step-1', 'test', { x: 1 });
      const key = generateIdempotencyKey(components);

      await store.create(key, components);
      await store.complete(key, { success: true });

      const record = await store.get(key);
      expect(record?.status).toBe('completed');
      expect(record?.result).toEqual({ success: true });
    });

    it('should fail record with error', async () => {
      const components = createIdempotencyKey('run-123', 'step-1', 'test', { x: 1 });
      const key = generateIdempotencyKey(components);

      await store.create(key, components);
      await store.fail(key, 'Something went wrong');

      const record = await store.get(key);
      expect(record?.status).toBe('failed');
      expect(record?.error).toBe('Something went wrong');
    });
  });

  describe('withIdempotency', () => {
    it('should execute function and cache result', async () => {
      let executionCount = 0;
      const components = createIdempotencyKey('run-123', 'step-1', 'test', { x: 1 });

      const result1 = await store.withIdempotency(components, async () => {
        executionCount++;
        return 'result';
      });

      const result2 = await store.withIdempotency(components, async () => {
        executionCount++;
        return 'result';
      });

      expect(executionCount).toBe(1); // Only executed once
      expect(result1).toBe('result');
      expect(result2).toBe('result');
    });
  });

  describe('listByRun', () => {
    it('should list all records for a run', async () => {
      await store.create(
        generateIdempotencyKey(createIdempotencyKey('run-123', 'step-1', 'op1', {})),
        createIdempotencyKey('run-123', 'step-1', 'op1', {})
      );
      await store.create(
        generateIdempotencyKey(createIdempotencyKey('run-123', 'step-2', 'op2', {})),
        createIdempotencyKey('run-123', 'step-2', 'op2', {})
      );
      await store.create(
        generateIdempotencyKey(createIdempotencyKey('run-456', 'step-1', 'op1', {})),
        createIdempotencyKey('run-456', 'step-1', 'op1', {})
      );

      const records = await store.listByRun('run-123');
      expect(records).toHaveLength(2);
    });
  });
});

// =============================================================================
// Error Taxonomy Tests
// =============================================================================

describe('Error Taxonomy', () => {
  describe('GwiError', () => {
    it('should create error with all properties', () => {
      const error = new GwiError('Test error', {
        code: 'INTERNAL_ERROR',
        retryable: false,
        context: { key: 'value' },
      });

      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.retryable).toBe(false);
      expect(error.context?.key).toBe('value');
      expect(error.message).toBe('Test error');
    });

    it('should serialize to JSON', () => {
      const error = new GwiError('Test error', { code: 'INTERNAL_ERROR' });
      const json = error.toJSON();

      expect(json.code).toBe('INTERNAL_ERROR');
      expect(json.message).toBe('Test error');
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('RetryableError', () => {
    it('should be retryable by default', () => {
      const error = new RetryableError('Rate limited', 'RATE_LIMITED');

      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBeDefined();
      expect(error.maxRetries).toBeDefined();
    });
  });

  describe('NonRetryableError', () => {
    it('should not be retryable', () => {
      const error = new NonRetryableError('Invalid input', 'VALIDATION_ERROR');

      expect(error.retryable).toBe(false);
    });
  });

  describe('PolicyDeniedError', () => {
    it('should include policy details', () => {
      const error = new PolicyDeniedError('Operation not allowed', {
        policyReasonCode: 'DENY_DESTRUCTIVE_NO_APPROVAL',
        toolName: 'github.deleteBranch',
      });

      expect(error.code).toBe('POLICY_DENIED');
      expect(error.policyReasonCode).toBe('DENY_DESTRUCTIVE_NO_APPROVAL');
      expect(error.toolName).toBe('github.deleteBranch');
    });
  });

  describe('ApprovalRequiredError', () => {
    it('should include approval type', () => {
      const error = new ApprovalRequiredError('Approval needed', 'destructive', {
        toolName: 'github.mergePR',
      });

      expect(error.code).toBe('APPROVAL_REQUIRED');
      expect(error.requiredApprovalType).toBe('destructive');
    });
  });

  describe('LockConflictError', () => {
    it('should be retryable', () => {
      const error = new LockConflictError('run-123', {
        holderId: 'holder-abc',
      });

      expect(error.code).toBe('LOCK_CONFLICT');
      expect(error.retryable).toBe(true);
      expect(error.runId).toBe('run-123');
    });
  });

  describe('isRetryable', () => {
    it('should return true for RetryableError', () => {
      expect(isRetryable(new RetryableError('test'))).toBe(true);
    });

    it('should return false for NonRetryableError', () => {
      expect(isRetryable(new NonRetryableError('test'))).toBe(false);
    });

    it('should detect retryable patterns in regular errors', () => {
      expect(isRetryable(new Error('Connection timeout'))).toBe(true);
      expect(isRetryable(new Error('Rate limit exceeded'))).toBe(true);
      expect(isRetryable(new Error('503 Service Unavailable'))).toBe(true);
    });
  });

  describe('toExitCode', () => {
    it('should map errors to exit codes', () => {
      expect(toExitCode(new RetryableError('test', 'RATE_LIMITED'))).toBe(10);
      expect(toExitCode(new RetryableError('test', 'TIMEOUT'))).toBe(11);
      expect(toExitCode(new NonRetryableError('test', 'VALIDATION_ERROR'))).toBe(20);
      expect(toExitCode(new PolicyDeniedError('test'))).toBe(30);
      expect(toExitCode(new ApprovalRequiredError('test'))).toBe(31);
    });
  });

  describe('toAuditEvent', () => {
    it('should convert error to audit event', () => {
      const error = new PolicyDeniedError('Not allowed');
      const event = toAuditEvent(error, { runId: 'run-123' });

      expect(event.type).toBe('error');
      expect(event.code).toBe('POLICY_DENIED');
      expect(event.message).toBe('Not allowed');
      expect(event.retryable).toBe(false);
      expect(event.context?.runId).toBe('run-123');
    });
  });
});

// =============================================================================
// Observability Tests
// =============================================================================

describe('Observability', () => {
  describe('Logger', () => {
    it('should create logger for component', () => {
      const logger = getLogger('test-component');
      expect(logger).toBeDefined();
    });

    it('should create child logger with context', () => {
      const parent = getLogger('parent');
      const child = parent.child({ runId: 'run-123' });

      expect(child).toBeDefined();
    });
  });

  describe('TraceContext', () => {
    it('should create trace context', () => {
      const ctx = createTraceContext('run-123', {
        tenantId: 'tenant-1',
        stepId: 'step-1',
      });

      expect(ctx.runId).toBe('run-123');
      expect(ctx.tenantId).toBe('tenant-1');
      expect(ctx.stepId).toBe('step-1');
      expect(ctx.spanId).toBeDefined();
      expect(ctx.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('MetricsRegistry', () => {
    let registry: DefaultMetricsRegistry;

    beforeEach(() => {
      registry = new DefaultMetricsRegistry();
      setMetricsRegistry(registry);
    });

    it('should increment counter', () => {
      registry.increment('test.counter');
      registry.increment('test.counter');
      registry.increment('test.counter');

      const metrics = registry.getMetrics();
      const counters = metrics.filter(m => m.name === 'test.counter');
      expect(counters).toHaveLength(3);
      expect(counters[2].value).toBe(3);
    });

    it('should record gauge', () => {
      registry.gauge('test.gauge', 42);

      const metrics = registry.getMetrics();
      expect(metrics.find(m => m.name === 'test.gauge')?.value).toBe(42);
    });

    it('should record histogram', () => {
      registry.histogram('test.histogram', 100);
      registry.histogram('test.histogram', 200);

      const metrics = registry.getMetrics();
      const histograms = metrics.filter(m => m.name === 'test.histogram');
      expect(histograms).toHaveLength(2);
    });

    it('should record timer', () => {
      registry.timer('test.timer', 150);

      const metrics = registry.getMetrics();
      expect(metrics.find(m => m.name === 'test.timer')?.value).toBe(150);
    });

    it('should start and stop timer', async () => {
      const stop = registry.startTimer('test.auto_timer');
      await new Promise(r => setTimeout(r, 10));
      stop();

      const metrics = registry.getMetrics();
      const timer = metrics.find(m => m.name === 'test.auto_timer');
      // setTimeout may fire up to ~1ms early against Date.now() millisecond
      // truncation; allow 2ms slack so the check is not flaky.
      expect(timer?.value).toBeGreaterThanOrEqual(8);
    });

    it('should support labels', () => {
      registry.increment('test.labeled', { status: 'success' });
      registry.increment('test.labeled', { status: 'error' });

      const metrics = registry.getMetrics();
      expect(metrics.filter(m => m.name === 'test.labeled')).toHaveLength(2);
    });

    it('should reset metrics', () => {
      registry.increment('test.counter');
      registry.reset();

      expect(registry.getMetrics()).toHaveLength(0);
    });
  });
});

// =============================================================================
// Resume/Replay Tests
// =============================================================================

describe('Resume/Replay', () => {
  // Helper to create mock run
  function createMockRun(overrides: Partial<SaaSRun> = {}): SaaSRun {
    return {
      id: 'run-123',
      tenantId: 'tenant-1',
      repoId: 'repo-1',
      prId: 'pr-1',
      prUrl: 'https://github.com/org/repo/pull/1',
      type: 'resolve',
      status: 'running',
      currentStep: 'coder',
      steps: [
        { id: 'step-1', runId: 'run-123', agent: 'triage', status: 'completed', output: { complexity: 3 } },
        { id: 'step-2', runId: 'run-123', agent: 'coder', status: 'running' },
        { id: 'step-3', runId: 'run-123', agent: 'reviewer', status: 'pending' },
      ],
      trigger: { source: 'ui' },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as SaaSRun;
  }

  describe('CheckpointManager', () => {
    let manager: CheckpointManager;

    beforeEach(() => {
      manager = new CheckpointManager();
    });

    it('should create checkpoint from run', () => {
      const run = createMockRun();
      const checkpoint = manager.createCheckpoint(run, { triageResult: 'data' });

      expect(checkpoint.runId).toBe('run-123');
      expect(checkpoint.tenantId).toBe('tenant-1');
      expect(checkpoint.currentStepIndex).toBe(1);
      expect(checkpoint.completedSteps).toContain('step-1');
      expect(checkpoint.artifacts.triageResult).toBe('data');
    });

    it('should retrieve checkpoint', () => {
      const run = createMockRun();
      manager.createCheckpoint(run, {});

      const retrieved = manager.getCheckpoint('run-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.runId).toBe('run-123');
    });

    it('should delete checkpoint', () => {
      const run = createMockRun();
      manager.createCheckpoint(run, {});

      const deleted = manager.deleteCheckpoint('run-123');
      expect(deleted).toBe(true);
      expect(manager.getCheckpoint('run-123')).toBeNull();
    });

    it('should list all checkpoints', () => {
      manager.createCheckpoint(createMockRun({ id: 'run-1' } as any), {});
      manager.createCheckpoint(createMockRun({ id: 'run-2' } as any), {});

      const checkpoints = manager.listCheckpoints();
      expect(checkpoints).toHaveLength(2);
    });
  });

  describe('analyzeResumePoint', () => {
    it('should find resume point from completed steps', () => {
      const run = createMockRun();
      const result = analyzeResumePoint(run, null);

      expect(result.success).toBe(true);
      expect(result.startFromStep).toBe('coder');
      expect(result.startFromIndex).toBe(1);
      expect(result.availableArtifacts?.triage).toEqual({ complexity: 3 });
    });

    it('should use checkpoint if available', () => {
      const run = createMockRun();
      const checkpoint = {
        runId: 'run-123',
        tenantId: 'tenant-1',
        currentStepIndex: 1,
        currentStepName: 'coder',
        status: 'running' as const,
        completedSteps: ['step-1'],
        artifacts: { cached: 'data' },
        checkpointedAt: new Date(),
      };

      const result = analyzeResumePoint(run, checkpoint);

      expect(result.success).toBe(true);
      expect(result.checkpoint).toBe(checkpoint);
      expect(result.availableArtifacts?.cached).toBe('data');
    });

    it('should force restart when requested', () => {
      const run = createMockRun();
      const result = analyzeResumePoint(run, null, { forceRestart: true });

      expect(result.success).toBe(true);
      expect(result.startFromIndex).toBe(0);
      expect(result.startFromStep).toBe('triage');
    });

    it('should skip to specific step', () => {
      const run = createMockRun();
      const result = analyzeResumePoint(run, null, { skipToStep: 'reviewer' });

      expect(result.success).toBe(true);
      expect(result.startFromStep).toBe('reviewer');
      expect(result.startFromIndex).toBe(2);
    });

    it('should fail for completed run', () => {
      const run = createMockRun({ status: 'completed' });
      const result = analyzeResumePoint(run, null);

      expect(result.success).toBe(false);
      expect(result.error).toContain('completed');
    });

    it('should fail for cancelled run', () => {
      const run = createMockRun({ status: 'cancelled' });
      const result = analyzeResumePoint(run, null);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });
  });

  describe('shouldSkipStep', () => {
    it('should skip completed steps', () => {
      const step: RunStep = {
        id: 'step-1',
        runId: 'run-123',
        agent: 'triage',
        status: 'completed',
      };

      expect(shouldSkipStep(step, new Set())).toBe(true);
    });

    it('should skip steps in completed set', () => {
      const step: RunStep = {
        id: 'step-1',
        runId: 'run-123',
        agent: 'triage',
        status: 'pending',
      };

      expect(shouldSkipStep(step, new Set(['step-1']))).toBe(true);
    });

    it('should not skip pending steps', () => {
      const step: RunStep = {
        id: 'step-2',
        runId: 'run-123',
        agent: 'coder',
        status: 'pending',
      };

      expect(shouldSkipStep(step, new Set(['step-1']))).toBe(false);
    });
  });

  describe('mergeArtifacts', () => {
    it('should merge artifacts with current taking precedence', () => {
      const prior = { a: 1, b: 2 };
      const current = { b: 3, c: 4 };

      const merged = mergeArtifacts(prior, current);

      expect(merged).toEqual({ a: 1, b: 3, c: 4 });
    });
  });
});
