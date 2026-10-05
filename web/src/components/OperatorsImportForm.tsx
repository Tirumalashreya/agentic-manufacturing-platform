"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { importOperatorsFileAction } from "@/app/(app)/actions";
import type { ImportSheetResult } from "@/lib/setup-import";

// Bulk import scoped to Shifts/Operators only — a sibling of the general
// /import page's single-step flow, not a duplicate of the whole importer:
// only Shift/Operator sheets are recognized here, anything else in the
// uploaded file is reported as skipped rather than silently pulled in.
export function OperatorsImportForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ImportSheetResult[] | null>(null);
  const [skippedSheets, setSkippedSheets] = useState<string[]>([]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResults(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await importOperatorsFileAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setResults(result.result);
      setSkippedSheets(result.skippedSheets);
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">Bulk import operators</h2>
      <p className="mt-1 text-xs text-muted">
        Upload a workbook with Shifts and/or Operators sheets (Skills and shift assignments ride
        along on each operator row — see the /import page&apos;s template for the exact columns).
      </p>
      <form ref={formRef} onSubmit={handleSubmit} className="mt-3 flex items-center gap-3">
        <input
          type="file"
          name="file"
          accept=".xlsx,.csv"
          required
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Importing…" : "Upload"}
        </Button>
      </form>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {results && (
        <div className="mt-3 flex flex-col gap-3">
          {skippedSheets.length > 0 && (
            <p className="text-sm text-warning">
              Skipped (not a Shift or Operator sheet): {skippedSheets.join(", ")}
            </p>
          )}
          {results.map((sheetResult) => (
            <div key={sheetResult.sheet} className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium text-foreground">
                {sheetResult.sheet} — {sheetResult.imported} imported
                {sheetResult.errors.length > 0 && `, ${sheetResult.errors.length} error(s)`}
              </p>
              {sheetResult.errors.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-sm text-danger">
                  {sheetResult.errors.map((rowError, i) => (
                    <li key={i}>Row {rowError.row}: {rowError.message}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
