/**
 * Simple Prometheus-compatible metrics collection.
 * 
 * This module provides basic counter and gauge metrics that can be
 * scraped by Prometheus or displayed via the /metrics endpoint.
 */

interface Counter {
  value: number;
  labels: Record<string, string>;
}

interface Gauge {
  value: number;
  labels: Record<string, string>;
}

class MetricsRegistry {
  private counters = new Map<string, Map<string, Counter>>();
  private gauges = new Map<string, Map<string, Gauge>>();
  private startTime = Date.now();

  /**
   * Increment a counter metric.
   */
  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.labelsToKey(labels);
    let metricMap = this.counters.get(name);
    if (!metricMap) {
      metricMap = new Map();
      this.counters.set(name, metricMap);
    }
    const existing = metricMap.get(key);
    if (existing) {
      existing.value += value;
    } else {
      metricMap.set(key, { value, labels: { ...labels } });
    }
  }

  /**
   * Set a gauge metric.
   */
  set(name: string, labels: Record<string, string> = {}, value: number): void {
    const key = this.labelsToKey(labels);
    let metricMap = this.gauges.get(name);
    if (!metricMap) {
      metricMap = new Map();
      this.gauges.set(name, metricMap);
    }
    const existing = metricMap.get(key);
    if (existing) {
      existing.value = value;
    } else {
      metricMap.set(key, { value, labels: { ...labels } });
    }
  }

  /**
   * Get the current value of a counter.
   */
  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = this.labelsToKey(labels);
    const metricMap = this.counters.get(name);
    return metricMap?.get(key)?.value ?? 0;
  }

  /**
   * Get the current value of a gauge.
   */
  getGauge(name: string, labels: Record<string, string> = {}): number {
    const key = this.labelsToKey(labels);
    const metricMap = this.gauges.get(name);
    return metricMap?.get(key)?.value ?? 0;
  }

  /**
   * Export metrics in Prometheus text format.
   */
  export(): string {
    const lines: string[] = [];
    const timestamp = Date.now();
    const uptime = (timestamp - this.startTime) / 1000;

    // Add metadata
    lines.push("# HELP gateway_uptime_seconds Gateway uptime in seconds");
    lines.push("# TYPE gateway_uptime_seconds gauge");
    lines.push(`gateway_uptime_seconds ${uptime.toFixed(3)}`);
    lines.push("");

    // Export counters
    for (const [name, metricMap] of this.counters) {
      lines.push(`# HELP ${name} ${this.helpText(name)}`);
      lines.push(`# TYPE ${name} counter`);
      for (const counter of metricMap.values()) {
        const labelStr = this.formatLabels(counter.labels);
        lines.push(`${name}${labelStr} ${counter.value}`);
      }
      lines.push("");
    }

    // Export gauges
    for (const [name, metricMap] of this.gauges) {
      lines.push(`# HELP ${name} ${this.helpText(name)}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const gauge of metricMap.values()) {
        const labelStr = this.formatLabels(gauge.labels);
        lines.push(`${name}${labelStr} ${gauge.value}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private labelsToKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return "";
    const labelStr = entries
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    return `{${labelStr}}`;
  }

  private helpText(name: string): string {
    const helpTexts: Record<string, string> = {
      gateway_requests_total: "Total number of requests",
      gateway_requests_duration_seconds: "Request duration in seconds",
      gateway_provider_errors_total: "Total provider errors",
      gateway_fallbacks_total: "Total fallback attempts",
      gateway_active_requests: "Number of active requests",
    };
    return helpTexts[name] ?? "Metric " + name;
  }
}

// Global registry instance
export const metrics = new MetricsRegistry();

/**
 * Middleware to track request metrics.
 */
export function trackRequest(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
): void {
  const route = path.replace(/\/[0-9a-f-]+/g, "/:id"); // Normalize IDs
  metrics.inc("gateway_requests_total", { method, route, status: String(statusCode) });
  metrics.inc("gateway_requests_duration_seconds", { method, route }, durationMs / 1000);
}

/**
 * Track provider execution.
 */
export function trackProvider(
  providerId: string,
  modelId: string,
  success: boolean,
  durationMs: number,
): void {
  const status = success ? "success" : "error";
  metrics.inc("gateway_provider_requests_total", { provider: providerId, model: modelId, status });
  metrics.set("gateway_provider_last_request_duration_seconds", { provider: providerId, model: modelId }, durationMs / 1000);
  if (!success) {
    metrics.inc("gateway_provider_errors_total", { provider: providerId, model: modelId });
  }
}

/**
 * Track fallback events.
 */
export function trackFallback(
  fromProvider: string,
  toProvider: string,
  reason: string,
): void {
  metrics.inc("gateway_fallbacks_total", { from: fromProvider, to: toProvider, reason });
}
