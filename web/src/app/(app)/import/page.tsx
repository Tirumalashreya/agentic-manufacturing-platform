import type { Metadata } from "next";
import { Download } from "lucide-react";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { ImportForm } from "@/components/ImportForm";
import { ClearDataButton } from "@/components/ClearDataButton";

export const metadata: Metadata = { title: "Import" };

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Import setup data"
        actions={
          plants.length > 0 && selectedPlant ? (
            <form method="get" className="flex items-center gap-2">
              <select
                name="plantId"
                defaultValue={selectedPlant.id}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>{p.code}</option>
                ))}
              </select>
              <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">Switch</button>
            </form>
          ) : undefined
        }
      />

      {!selectedPlant ? (
        <EmptyState title="No plants exist yet" />
      ) : (
        <>
          <Card>
            <h2 className="text-sm font-semibold text-foreground">Bulk import a plant's setup</h2>
            <p className="mt-1 text-sm text-muted">
              Upload one Excel workbook (sheets for Work Centers, Machines, Products,
              Routings, Routing Operations, Customers, Orders, Shifts, and Operators) or a
              single .csv file (treated as one sheet). Everything imports into{" "}
              <strong>{selectedPlant.code}</strong>, cross-referenced by code/SKU/name — no
              database IDs needed. Rows are validated independently, so one bad row doesn&apos;t
              block the rest.
            </p>
            <a
              href="/import/template"
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-brand-600 hover:underline"
            >
              <Download size={14} />
              Download template workbook
            </a>
          </Card>

          <Card>
            <ImportForm plantId={selectedPlant.id} />
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-foreground">Start over</h2>
            <p className="mt-1 text-sm text-muted">
              Wipe everything imported so far and reimport a fresh file — no more asking for a
              manual reset.
            </p>
            <div className="mt-3">
              <ClearDataButton />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
