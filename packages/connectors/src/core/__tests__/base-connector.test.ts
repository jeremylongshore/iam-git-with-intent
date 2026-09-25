import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseConnector, ConsoleLogger, NoOpMetrics } from '../base-connector.js';
import type {
  ConnectorConfig,
  AuthResult,
  HealthStatus,
  SyncOptions,
  ConnectorRecord,
  WebhookEvent,
  WebhookResult,
  ConnectorMetadata
} from '../../interfaces/types.js';
import { ConnectorConfigSchema } from '../../interfaces/types.js';

class MockConnector extends BaseConnector {
  readonly name = 'mock';
  readonly version = '1.0.0';
  readonly configSchema = ConnectorConfigSchema;

  async authenticate(_config: ConnectorConfig): Promise<AuthResult> {
    return { success: true, token: 'mock-token' };
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      timestamp: new Date().toISOString(),
      connector: this.name,
      checks: [
        { name: 'api_reachable', status: 'pass', durationMs: 50 }
      ]
    };
  }

  async *sync(_options: SyncOptions): AsyncIterator<ConnectorRecord> {
    yield {
      id: '1',
      type: 'test',
      source: this.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: { test: true }
    };
  }

  async processWebhook(_event: WebhookEvent): Promise<WebhookResult> {
    return {
      success: true,
      durationMs: 100
    };
  }

  getMetadata(): ConnectorMetadata {
    return {
      name: this.name,
      version: this.version,
      recordTypes: ['test'],
      authMethods: ['bearer'],
      supportsIncremental: false,
      supportsWebhooks: false,
      rateLimits: {
        requestsPerSecond: 10,
        requestsPerHour: 1000
      },
      capabilities: ['sync']
    };
  }
}

describe('BaseConnector', () => {
  let connector: MockConnector;
  let logger: ConsoleLogger;
  let metrics: NoOpMetrics;

  beforeEach(() => {
    logger = new ConsoleLogger({ test: true });
    metrics = new NoOpMetrics();
    connector = new MockConnector(logger, metrics);
  });

  describe('retryRequest', () => {
    it('should succeed on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await connector['retryRequest'](fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success');

      const result = await connector['retryRequest'](fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
        retryableErrors: () => true
      });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(
        connector['retryRequest'](fn, {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 100,
          backoffMultiplier: 2,
          retryableErrors: () => true
        })
      ).rejects.toThrow('Max retries exceeded');

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Not retryable'));

      await expect(
        connector['retryRequest'](fn, {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 100,
          backoffMultiplier: 2,
          retryableErrors: () => false
        })
      ).rejects.toThrow('Max retries exceeded');

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkRateLimit', () => {
    it('should detect 429 status code', () => {
      const response = {
        status: 429,
        headers: { 'retry-after': '60' }
      };

      const retryAfter = connector['checkRateLimit'](response);

      expect(retryAfter).toBe(60000);
    });

    it('should parse timestamp retry-after', () => {
      const futureTime = Math.floor(Date.now() / 1000) + 120;
      const response = {
        status: 429,
        headers: { 'retry-after': futureTime.toString() }
      };

      const retryAfter = connector['checkRateLimit'](response);

      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(120000);
    });

    it('should return null for non-rate-limited response', () => {
      const response = {
        status: 200,
        headers: {}
      };

      const retryAfter = connector['checkRateLimit'](response);

      expect(retryAfter).toBeNull();
    });
  });

  describe('sleep', () => {
    it('should sleep for specified duration', async () => {
      const start = Date.now();
      await connector['sleep'](50);
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(45);
      // Upper bound is loose: under parallel test load a 50ms sleep was
      // observed at 264-334ms. The check is that sleep waits, not how precisely.
      expect(duration).toBeLessThanOrEqual(1000);
    });
  });

  describe('lifecycle hooks', () => {
    it('should call onBeforeSync', async () => {
      const spy = vi.spyOn(connector as any, 'onBeforeSync');

      await connector['onBeforeSync']({ limit: 10 });

      expect(spy).toHaveBeenCalledWith({ limit: 10 });
    });

    it('should call onAfterSync', async () => {
      const spy = vi.spyOn(connector as any, 'onAfterSync');

      await connector['onAfterSync']({
        cursor: 'next',
        recordsProcessed: 100,
        errors: []
      });

      expect(spy).toHaveBeenCalledWith({
        cursor: 'next',
        recordsProcessed: 100,
        errors: []
      });
    });

    it('should call onError', async () => {
      const spy = vi.spyOn(connector as any, 'onError');
      const error = new Error('Test error');

      await connector['onError'](error, { context: 'test' });

      expect(spy).toHaveBeenCalledWith(error, { context: 'test' });
    });
  });

  describe('logger', () => {
    it('should log messages', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      connector['log']('info', 'Test message', { meta: 'data' });

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});

describe('ConsoleLogger', () => {
  it('should log with context', () => {
    const logger = new ConsoleLogger({ service: 'test' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('Test message', { extra: 'data' });

    expect(consoleSpy).toHaveBeenCalled();
    const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(loggedData.level).toBe('info');
    expect(loggedData.message).toBe('Test message');
    expect(loggedData.service).toBe('test');
    expect(loggedData.extra).toBe('data');

    consoleSpy.mockRestore();
  });

  it('should create child logger', () => {
    const logger = new ConsoleLogger({ service: 'test' });
    const child = logger.child({ module: 'sub' });

    expect(child).toBeInstanceOf(ConsoleLogger);
  });
});

describe('NoOpMetrics', () => {
  it('should not throw on metric calls', () => {
    const metrics = new NoOpMetrics();

    expect(() => metrics.increment('test', 1)).not.toThrow();
    expect(() => metrics.gauge('test', 100)).not.toThrow();
    expect(() => metrics.histogram('test', 50)).not.toThrow();
  });
});
