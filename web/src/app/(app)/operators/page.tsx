import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { OperatorsManager } from "@/components/OperatorsManager";
import { OperatorsImportForm } from "@/components/OperatorsImportForm";

export const metadata: Metadata = { title: "Operators" };

// Operator is not plant-scoped (see schema.prisma) — unlike Orders/Machines,
// operators are a single enterprise-wide workforce, so this page has no
// plant selector.
export default async function OperatorsPage() {
  const [operators, skills, shifts] = await Promise.all([
    prisma.operator.findMany({
      include: { skills: { include: { skill: true } }, shifts: { include: { shift: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.skill.findMany({ orderBy: { name: "asc" } }),
    prisma.shift.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-foreground">Operators</h1>
      <OperatorsImportForm />
      <OperatorsManager operators={operators} skills={skills} shifts={shifts} />
    </div>
  );
}
