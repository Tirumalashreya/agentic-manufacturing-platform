"use server";

import { revalidatePath } from "next/cache";
import {
  analyzeSetupWorkbook,
  commitSetupImport,
  type SheetAnalysis,
  type ConfirmedSheet,
  type ImportSheetResult,
} from "@/lib/setup-import";

// Phase 1 — read-only. Reads every sheet in the workbook (whatever it's
// named) and returns a fuzzy-matched guess of each sheet's entity type and
// column mapping, for the user to review/correct before anything commits.
export async function analyzeSetupFileAction(
  formData: FormData
): Promise<{ ok: true; sheets: SheetAnalysis[] } | { ok: false; error: string }> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file selected" };
  }
  if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".csv")) {
    return { ok: false, error: "File must be a .xlsx workbook or a .csv file" };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const sheets = await analyzeSetupWorkbook(buffer, file.name);
    return { ok: true, sheets };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Phase 2 — writes, using the human-confirmed entity type + column mapping
// per sheet (built entirely from what analyzeSetupFileAction already
// returned — no file re-upload needed). Kept for programmatic/future use;
// the current UI uses importSetupFileAction below instead.
export async function commitSetupImportAction(
  plantId: string,
  confirmedSheets: ConfirmedSheet[]
): Promise<{ ok: true; result: ImportSheetResult[] } | { ok: false; error: string }> {
  try {
    const result = await commitSetupImport(plantId, confirmedSheets);
    revalidatePath("/production-planning");
    revalidatePath("/orders");
    revalidatePath("/schedule");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// One-step import: guesses each sheet's entity type + column mapping and
// commits immediately on the best guess — no review screen. The guessing
// logic is identical to analyzeSetupFileAction (same verified fuzzy-match
// heuristics); a sheet that can't be confidently classified is skipped and
// reported, not silently dropped.
export async function importSetupFileAction(
  plantId: string,
  formData: FormData
): Promise<
  | { ok: true; result: ImportSheetResult[]; skippedSheets: string[] }
  | { ok: false; error: string }
> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file selected" };
  }
  if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".csv")) {
    return { ok: false, error: "File must be a .xlsx workbook or a .csv file" };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const sheets = await analyzeSetupWorkbook(buffer, file.name);

    const confirmedSheets: ConfirmedSheet[] = [];
    const skippedSheets: string[] = [];
    for (const sheet of sheets) {
      if (!sheet.guessedEntityType) {
        skippedSheets.push(sheet.sheetName);
        continue;
      }
      const fieldMapping: Record<string, string> = {};
      for (const mapping of sheet.mappingsByEntityType[sheet.guessedEntityType]) {
        if (mapping.column) fieldMapping[mapping.field] = mapping.column;
      }
      confirmedSheets.push({ entityType: sheet.guessedEntityType, rows: sheet.rows, fieldMapping });
    }

    const result = await commitSetupImport(plantId, confirmedSheets);
    revalidatePath("/production-planning");
    revalidatePath("/orders");
    revalidatePath("/schedule");
    return { ok: true, result, skippedSheets };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
