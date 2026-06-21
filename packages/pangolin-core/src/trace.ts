// Correlation identity for a dispatch — the lightweight "tracing" surface (observability 3b).
// Pure data; carried on DispatchWork and every LifecycleEvent so a consumer can follow one
// logical unit of work (run -> item -> dispatch) on the LIVE telemetry stream. Not OTel spans.
//
// `traceId` is ALWAYS populated by the producer: the orchestrator sets it to the runId; a
// standalone client.dispatch defaults it to the dispatchId (a single-dispatch trace). Readable
// ids — not W3C traceparent hex. These ids must never leak into metric labels (cardinality).

export interface TraceContext {
  /** The logical operation this dispatch belongs to. Orchestrated: the runId.
   *  Standalone client.dispatch: the dispatchId. */
  traceId: string;
  /** Set when the dispatch is part of an orchestrated run. */
  runId?: string;
  /** The run item that produced this dispatch (an item may retry -> several dispatches share itemId). */
  itemId?: string;
}
