/**
 * GWI Span → OpenTelemetry ReadableSpan Bridge
 *
 * Converts ended GWI Span objects into OTel-compatible ReadableSpan format
 * so they can be fed into OTel's BatchSpanProcessor for export.
 *
 * @module @gwi/core/telemetry/exporters/span-bridge
 */

import {
  SpanKind as OTelSpanKind,
  SpanStatusCode,
  type SpanContext,
  TraceFlags,
} from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-node';
import type { Resource } from '@opentelemetry/resources';
import type { Span, SpanKind } from '../tracing.js';

// =============================================================================
// HrTime helpers
// =============================================================================

type HrTime = [number, number];

function dateToHrTime(date: Date): HrTime {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;
  return [seconds, nanos];
}

function hrTimeDuration(start: HrTime, end: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [seconds, nanos];
}

// =============================================================================
// SpanKind mapping
// =============================================================================

const SPAN_KIND_MAP: Record<SpanKind, OTelSpanKind> = {
  INTERNAL: OTelSpanKind.INTERNAL,
  SERVER: OTelSpanKind.SERVER,
  CLIENT: OTelSpanKind.CLIENT,
  PRODUCER: OTelSpanKind.PRODUCER,
  CONSUMER: OTelSpanKind.CONSUMER,
};

// =============================================================================
// GwiSpanBridge
// =============================================================================

/**
 * Bridges GWI Span objects to OTel ReadableSpan format.
 *
 * Usage:
 *   const bridge = new GwiSpanBridge(resource);
 *   const readableSpan = bridge.convert(gwiSpan);
 */
export class GwiSpanBridge {
  private resource: Resource;

  constructor(resource: Resource) {
    this.resource = resource;
  }

  /**
   * Convert a GWI Span (must be ended) into an OTel ReadableSpan.
   */
  convert(span: Span): ReadableSpan {
    if (!span.isEnded()) {
      throw new Error('Cannot bridge a span that has not ended');
    }

    const gwiStatus = span.getStatus();
    const startTime = dateToHrTime(span.startTime);
    const durationMs = span.getDurationMs() ?? 0;
    const endDate = new Date(span.startTime.getTime() + durationMs);
    const endTime = dateToHrTime(endDate);

    const spanContext: SpanContext = {
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: TraceFlags.SAMPLED,
    };

    // Map GWI events to OTel TimedEvents
    const events: TimedEvent[] = span.getEvents().map((evt) => ({
      name: evt.name,
      time: dateToHrTime(evt.timestamp),
      attributes: sanitizeAttributes(evt.attributes ?? {}),
    }));

    // Map status
    let statusCode: SpanStatusCode;
    switch (gwiStatus.status) {
      case 'OK':
        statusCode = SpanStatusCode.OK;
        break;
      case 'ERROR':
        statusCode = SpanStatusCode.ERROR;
        break;
      default:
        statusCode = SpanStatusCode.UNSET;
    }

    const readableSpan: ReadableSpan = {
      name: span.name,
      kind: SPAN_KIND_MAP[span.kind] ?? OTelSpanKind.INTERNAL,
      spanContext: () => spanContext,
      // SDK 2.x replaced parentSpanId with a full parent SpanContext.
      parentSpanContext: span.parentSpanId
        ? {
            traceId: span.traceId,
            spanId: span.parentSpanId,
            traceFlags: TraceFlags.SAMPLED,
          }
        : undefined,
      startTime,
      endTime,
      status: {
        code: statusCode,
        message: gwiStatus.message,
      },
      attributes: sanitizeAttributes(span.getAttributes()),
      links: [],
      events,
      duration: hrTimeDuration(startTime, endTime),
      ended: true,
      resource: this.resource,
      instrumentationScope: {
        name: '@gwi/core',
        version: '0.7.1',
      },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };

    return readableSpan;
  }
}

/**
 * Strip undefined values from attributes (OTel requires defined values).
 */
function sanitizeAttributes(
  attrs: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
