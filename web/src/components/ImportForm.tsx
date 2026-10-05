"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { importSetupFileAction } from "@/app/(app)/import/actions";
import type { ImportSheetResult } from "@/lib/setup-import";

// Single-step import: upload → the system guesses each sheet's meaning and
// column mapping (fuzzy-matched against the sheet names/columns you build
// your workbook with) → commits immediately. A sheet it can't confidently
// classify is skipped and reported, not silently dropped, so nothing
// disappears without a trace.
export function ImportForm({ plantId }: { plantId: string }) {
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
      const result = await importSetupFileAction(plantId, formData);
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
    <div className="flex flex-col gap-4">
      <form ref={formRef} onSubmit={handleSubmit} className="flex items-center gap-3">
        <input
          type="file"
          name="file"
          accept=".xlsx,.csv"
          required
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />
        <Button type="submit" disabled={isPending}>
          {isPending ? "Importing…" : "Upload"}
        </Button>
      </form>

      {error && <p className="text-sm text-danger">{error}</p>}

      {results && (
        <div className="flex flex-col gap-3">
          {skippedSheets.length > 0 && (
            <p className="text-sm text-warning">
              Couldn&apos;t recognize: {skippedSheets.join(", ")} — no matching data type found for these sheets.
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
