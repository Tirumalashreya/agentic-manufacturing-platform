// Stage 01 ("Fail Loud, Fail Closed"): a typed error for the exact shape of
// bug the architecture baseline found repeated across every Kafka producer
// call site — a DB write commits, the subsequent `publish()` call throws,
// and (with no local try/catch) express-async-errors turns that into an
// opaque HTTP 500 indistinguishable from "the write itself failed." A
// caller seeing a 500 cannot tell whether to retry (safe, if the write
// never happened) or not (unsafe, if it already did) — see
// ARCHITECTURE_BASELINE.md §5/§6/§11.
//
// This is deliberately NOT a distributed-transaction mechanism and does
// NOT roll anything back — the DB commit already happened and stays
// committed. It only carries enough structured context for a caller to
// know that happened, and to log/report it accurately instead of silently
// losing it or misrepresenting it.
export class DownstreamSyncError extends Error {
  readonly operation: string;
  readonly target: string;
  readonly entityId: string;

  constructor(params: { operation: string; target: string; entityId: string; cause: unknown }) {
    const causeMessage = params.cause instanceof Error ? params.cause.message : String(params.cause);
    super(
      `${params.operation} committed successfully, but downstream sync to ${params.target} failed for ${params.entityId}: ${causeMessage}`,
      { cause: params.cause }
    );
    this.name = "DownstreamSyncError";
    this.operation = params.operation;
    this.target = params.target;
    this.entityId = params.entityId;
  }
}
