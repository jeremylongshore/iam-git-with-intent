/**
 * OpenTelemetry SDK Initialization
 *
 * Bridge layer: initializes OTel SDK as the export backend for the GWI
 * custom telemetry system. The GWI Tracer/MetricsRegistry remain the
 * application-level API; OTel handles export to OTLP collectors.
 *
 * Conditional activation: only initializes when OTEL_EXPORTER_OTLP_ENDPOINT
 * is set or GWI_METRICS_EXPORTER=otel.
 *
 * @module @gwi/core/telemetry/exporters/otel
 */

import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

import { setTracer, createTracer, type Span } from '../tracing.js';
import { getMetricsRegistry } from '../metrics.js';
import { GwiSpanBridge } from './span-bridge.js';
import { MetricsBridge } from './metrics-bridge.js';

// =============================================================================
// Module State
// =============================================================================

let tracerProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;
let metricsBridge: MetricsBridge | null = null;
let spanBridge: GwiSpanBridge | null = null;
let batchProcessor: BatchSpanProcessor | null = null;
let initialized = false;

// =============================================================================
// Options
// =============================================================================

export interface OTelInitOptions {
  /** Service name for resource attribution */
  serviceName: string;
  /** Service version (default: process.env.APP_VERSION ?? '0.7.1') */
  serviceVersion?: string;
  /** Deployment environment (default: process.env.DEPLOYMENT_ENV ?? 'production') */
  environment?: string;
  /** OTLP endpoint override (default: OTEL_EXPORTER_OTLP_ENDPOINT env var) */
  otlpEndpoint?: string;
  /** Metrics sync interval in ms (default: 60000) */
  metricsSyncIntervalMs?: number;
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize OTel SDK as the export layer for GWI telemetry.
 *
 * Only activates when OTEL_EXPORTER_OTLP_ENDPOINT is set or
 * GWI_METRICS_EXPORTER=otel. Safe to call unconditionally.
 */
export function initializeOTel(options: OTelInitOptions): void {
  if (initialized) return;

  const endpoint =
    options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const metricsExporter = process.env.GWI_METRICS_EXPORTER;

  // Only activate if there's an endpoint or explicit otel exporter config
  if (!endpoint && metricsExporter !== 'otel') {
    return;
  }

  const serviceVersion =
    options.serviceVersion ?? process.env.APP_VERSION ?? '0.7.1';
  const environment =
    options.environment ?? process.env.DEPLOYMENT_ENV ?? 'production';

  // Create OTel Resource
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': environment,
  });

  // --- Trace Provider ---
  // SDK 2.x: span processors are passed to the constructor
  // (addSpanProcessor was removed).
  if (endpoint) {
    const traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    });
    batchProcessor = new BatchSpanProcessor(traceExporter);
  }
  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: batchProcessor ? [batchProcessor] : [],
  });

  tracerProvider.register();

  // Create span bridge
  spanBridge = new GwiSpanBridge(resource);

  // --- Meter Provider ---
  if (endpoint) {
    const metricExporter = new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
    });
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: options.metricsSyncIntervalMs ?? 60_000,
    });
    meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  } else {
    meterProvider = new MeterProvider({ resource });
  }

  // --- Wire Span Bridge into GWI Tracer ---
  // Replace the default tracer with one that pipes ended spans to OTel
  const currentBridge = spanBridge;
  const currentProcessor = batchProcessor;
  const gwiTracer = createTracer({
    serviceName: options.serviceName,
    serviceVersion,
    enabled: true,
    onSpanEnd: (span: Span) => {
      if (currentProcessor && currentBridge) {
        try {
          const otelSpan = currentBridge.convert(span);
          currentProcessor.onEnd(otelSpan);
        } catch {
          // Silently ignore bridge errors to avoid disrupting app flow
        }
      }
    },
  });
  setTracer(gwiTracer);

  // --- Wire Metrics Bridge ---
  const meter = meterProvider.getMeter(options.serviceName, serviceVersion);
  metricsBridge = new MetricsBridge(getMetricsRegistry(), meter, {
    syncIntervalMs: options.metricsSyncIntervalMs ?? 60_000,
  });
  metricsBridge.start();

  initialized = true;
}

// =============================================================================
// Shutdown
// =============================================================================

/**
 * Gracefully flush and shut down OTel providers.
 * Call on SIGTERM/SIGINT before process.exit().
 */
export async function shutdownOTel(): Promise<void> {
  if (!initialized) return;

  // Stop metrics bridge periodic sync
  metricsBridge?.stop();

  // Flush trace processor
  if (batchProcessor) {
    try {
      await batchProcessor.forceFlush();
    } catch {
      // Best-effort flush
    }
  }

  // Shutdown providers
  if (tracerProvider) {
    try {
      await tracerProvider.shutdown();
    } catch {
      // Best-effort shutdown
    }
  }

  if (meterProvider) {
    try {
      await meterProvider.shutdown();
    } catch {
      // Best-effort shutdown
    }
  }

  initialized = false;
  tracerProvider = null;
  meterProvider = null;
  metricsBridge = null;
  spanBridge = null;
  batchProcessor = null;
}
