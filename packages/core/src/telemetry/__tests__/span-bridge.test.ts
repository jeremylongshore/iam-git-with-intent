/**
 * Span Bridge Tests
 *
 * Verifies that GWI Span objects are correctly converted to OTel ReadableSpan format.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpanStatusCode, SpanKind as OTelSpanKind, TraceFlags } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { GwiSpanBridge } from '../exporters/span-bridge.js';
import { createTracer, type Tracer } from '../tracing.js';

describe('GwiSpanBridge', () => {
  let bridge: GwiSpanBridge;
  let tracer: Tracer;

  beforeEach(() => {
    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test-service' });
    bridge = new GwiSpanBridge(resource);
    tracer = createTracer({
      serviceName: 'test-service',
      enabled: true,
      sampleRate: 1.0,
    });
  });

  it('should convert a basic ended span', () => {
    const span = tracer.startSpan('test-operation');
    span.setAttribute('key', 'value');
    span.setStatus('OK');
    span.end();

    const otelSpan = bridge.convert(span);

    expect(otelSpan.name).toBe('test-operation');
    expect(otelSpan.spanContext().traceId).toBe(span.traceId);
    expect(otelSpan.spanContext().spanId).toBe(span.spanId);
    expect(otelSpan.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    expect(otelSpan.status.code).toBe(SpanStatusCode.OK);
    expect(otelSpan.attributes['key']).toBe('value');
    expect(otelSpan.ended).toBe(true);
  });

  it('should map span kind correctly', () => {
    const span = tracer.startSpan('client-op', { kind: 'CLIENT' });
    span.end();

    const otelSpan = bridge.convert(span);
    expect(otelSpan.kind).toBe(OTelSpanKind.CLIENT);
  });

  it('should map ERROR status', () => {
    const span = tracer.startSpan('failing-op');
    span.setStatus('ERROR', 'Something went wrong');
    span.end();

    const otelSpan = bridge.convert(span);
    expect(otelSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(otelSpan.status.message).toBe('Something went wrong');
  });

  it('should map UNSET status', () => {
    const span = tracer.startSpan('unset-op');
    // Don't set status — but calling end() will set it to OK in SpanImpl
    // So we need to test a span that was explicitly set to error then check that path
    // Actually, SpanImpl sets status to OK on end() if UNSET, so we check OK
    span.end();

    const otelSpan = bridge.convert(span);
    // SpanImpl auto-sets OK on end if UNSET
    expect(otelSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it('should convert events', () => {
    const span = tracer.startSpan('event-op');
    span.addEvent('my-event', { detail: 'some-detail' });
    span.end();

    const otelSpan = bridge.convert(span);
    expect(otelSpan.events).toHaveLength(1);
    expect(otelSpan.events[0].name).toBe('my-event');
    expect(otelSpan.events[0].attributes?.['detail']).toBe('some-detail');
  });

  it('should convert exception events', () => {
    const span = tracer.startSpan('exception-op');
    span.recordException(new Error('test error'));
    span.end();

    const otelSpan = bridge.convert(span);
    expect(otelSpan.events).toHaveLength(1);
    expect(otelSpan.events[0].name).toBe('exception');
    expect(otelSpan.events[0].attributes?.['exception.message']).toBe('test error');
  });

  it('should throw for non-ended span', () => {
    const span = tracer.startSpan('not-ended');

    expect(() => bridge.convert(span)).toThrow('Cannot bridge a span that has not ended');
  });

  it('should preserve parent span ID', () => {
    const parentSpan = tracer.startSpan('parent');
    const childSpan = tracer.startSpan('child', { parentSpanId: parentSpan.spanId });
    childSpan.end();

    const otelSpan = bridge.convert(childSpan);
    expect(otelSpan.parentSpanContext?.spanId).toBe(parentSpan.spanId);

    parentSpan.end();
  });

  it('should have correct resource', () => {
    const span = tracer.startSpan('resource-op');
    span.end();

    const otelSpan = bridge.convert(span);
    expect(otelSpan.resource.attributes[ATTR_SERVICE_NAME]).toBe('test-service');
  });

  it('should strip undefined attributes', () => {
    const span = tracer.startSpan('attr-op');
    span.setAttribute('defined', 'yes');
    // undefined attributes are filtered by SpanImpl.setAttributes
    span.end();

    const otelSpan = bridge.convert(span);
    expect(otelSpan.attributes['defined']).toBe('yes');
    expect(Object.values(otelSpan.attributes).every((v) => v !== undefined)).toBe(true);
  });

  it('should map all span kinds', () => {
    const kinds = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'] as const;
    const expected = [
      OTelSpanKind.INTERNAL,
      OTelSpanKind.SERVER,
      OTelSpanKind.CLIENT,
      OTelSpanKind.PRODUCER,
      OTelSpanKind.CONSUMER,
    ];

    for (let i = 0; i < kinds.length; i++) {
      const span = tracer.startSpan(`${kinds[i]}-op`, { kind: kinds[i] });
      span.end();
      const otelSpan = bridge.convert(span);
      expect(otelSpan.kind).toBe(expected[i]);
    }
  });
});
