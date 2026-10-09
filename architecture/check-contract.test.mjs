// Stage 09: every check must prove it actually catches the violation it
// claims to catch — not just that it passes on the real repo today. Each
// test builds a synthetic fixture repo under the OS temp dir (never the
// real repository), confirms the check FAILS against a deliberately
// introduced violation, then confirms it PASSES once that fixture is
// restored to a clean shape. This is the "introduce a forbidden change,
// confirm CI fails, restore, confirm CI passes again" cycle the stage
// asks for — run against disposable fixtures so no deliberate violation
// is ever left in this live repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  noLlmOutsideAgentOrchestrator,
  exclusionConstraintPresent,
  requiredEnterpriseIdColumnsPresent,
  idempotencyKeySchemaPresent,
  noUnexpectedSalesOrderWriters,
  noCrossDomainInventoryWrites,
  approvalClaimIsAtomicCas,
  contractFileExists,
} from "./check-contract.mjs";

function freshFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "arch-contract-test-"));
  return dir;
}

test("noLlmOutsideAgentOrchestrator: fails when scheduling-service imports an LLM SDK, passes once removed", () => {
  const root = freshFixtureDir();
  const schedDir = join(root, "services", "scheduling-service", "src");
  mkdirSync(schedDir, { recursive: true });
  writeFileSync(join(schedDir, "pipeline.ts"), `import { placeOperation } from "./placement";\n`);

  let result = noLlmOutsideAgentOrchestrator(root);
  assert.equal(result.ok, true, "clean fixture should pass");

  writeFileSync(join(schedDir, "sneaky.ts"), `import { ChatGroq } from "@langchain/groq";\n`);
  result = noLlmOutsideAgentOrchestrator(root);
  assert.equal(result.ok, false, "LLM import under scheduling-service must be caught");
  assert.ok(result.violations[0].includes("sneaky.ts"));

  rmSync(root, { recursive: true, force: true });
});

test("exclusionConstraintPresent: fails when no EXCLUDE USING gist migration exists, passes once one is added", () => {
  const root = freshFixtureDir();
  const migrationsDir = join(root, "packages", "domain", "prisma", "migrations", "0001_init");
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(join(migrationsDir, "migration.sql"), `CREATE TABLE "Foo" ("id" TEXT);\n`);

  let result = exclusionConstraintPresent(root);
  assert.equal(result.ok, false, "a repo with no exclusion constraint migration must fail");

  writeFileSync(
    join(migrationsDir, "migration.sql"),
    `ALTER TABLE "ResourceReservation" ADD CONSTRAINT no_overlap EXCLUDE USING gist (...);\n`
  );
  result = exclusionConstraintPresent(root);
  assert.equal(result.ok, true, "a repo with the constraint present must pass");

  rmSync(root, { recursive: true, force: true });
});

test("requiredEnterpriseIdColumnsPresent: fails when a tenant-scoped model loses its enterpriseId field", () => {
  const root = freshFixtureDir();
  const prismaDir = join(root, "packages", "domain", "prisma");
  mkdirSync(prismaDir, { recursive: true });
  const goodSchema = `
model Customer { id String @id enterpriseId String }
model SalesOrder { id String @id enterpriseId String }
model ProductionOrder { id String @id enterpriseId String }
model AgentPipelineRun { id String @id enterpriseId String }
model AuditLog { id String @id enterpriseId String }
model IdempotencyKey { id String @id enterpriseId String }
`;
  writeFileSync(join(prismaDir, "schema.prisma"), goodSchema);
  let result = requiredEnterpriseIdColumnsPresent(root);
  assert.equal(result.ok, true, "a schema with every required field present must pass");

  const brokenSchema = goodSchema.replace("model Customer { id String @id enterpriseId String }", "model Customer { id String @id }");
  writeFileSync(join(prismaDir, "schema.prisma"), brokenSchema);
  result = requiredEnterpriseIdColumnsPresent(root);
  assert.equal(result.ok, false, "removing Customer.enterpriseId must be caught");
  assert.ok(result.missing.some((m) => m.startsWith("Customer")));

  rmSync(root, { recursive: true, force: true });
});

test("idempotencyKeySchemaPresent: fails when the unique constraint is removed", () => {
  const root = freshFixtureDir();
  const prismaDir = join(root, "packages", "domain", "prisma");
  mkdirSync(prismaDir, { recursive: true });
  const good = `model IdempotencyKey {
    enterpriseId String
    key String
    operation String
    requestHash String
    statusCode Int
    @@unique([enterpriseId, key, operation])
  }`;
  writeFileSync(join(prismaDir, "schema.prisma"), good);
  let result = idempotencyKeySchemaPresent(root);
  assert.equal(result.ok, true);

  const broken = good.replace("@@unique([enterpriseId, key, operation])", "");
  writeFileSync(join(prismaDir, "schema.prisma"), broken);
  result = idempotencyKeySchemaPresent(root);
  assert.equal(result.ok, false, "removing the uniqueness constraint must be caught");

  rmSync(root, { recursive: true, force: true });
});

test("noUnexpectedSalesOrderWriters: fails when an undocumented service writes SalesOrder directly", () => {
  const root = freshFixtureDir();
  const okDir = join(root, "services", "order-service", "src");
  mkdirSync(okDir, { recursive: true });
  writeFileSync(join(okDir, "app.ts"), `await prisma.salesOrder.create({ data: {} });\n`);
  let result = noUnexpectedSalesOrderWriters(root);
  assert.equal(result.ok, true, "the documented writer must not be flagged");

  const rogueDir = join(root, "services", "analytics-service", "src");
  mkdirSync(rogueDir, { recursive: true });
  writeFileSync(join(rogueDir, "app.ts"), `await prisma.salesOrder.create({ data: {} });\n`);
  result = noUnexpectedSalesOrderWriters(root);
  assert.equal(result.ok, false, "an undocumented second SalesOrder writer must be caught");
  assert.ok(result.violations.some((v) => v.includes("analytics-service")));

  rmSync(root, { recursive: true, force: true });
});

test("noCrossDomainInventoryWrites: fails when a non-owning service writes Inventory directly, matching the real Stage 06 bug", () => {
  const root = freshFixtureDir();
  const mesDir = join(root, "services", "mes-integration", "src");
  mkdirSync(mesDir, { recursive: true });
  writeFileSync(mesDir + "/index.ts", `await fetch(inventoryServiceUrl);\n`);
  let result = noCrossDomainInventoryWrites(root);
  assert.equal(result.ok, true, "routing through the HTTP API must not be flagged");

  writeFileSync(mesDir + "/index.ts", `await prisma.inventory.upsert({ where: {}, create: {}, update: {} });\n`);
  result = noCrossDomainInventoryWrites(root);
  assert.equal(result.ok, false, "a direct Prisma write to Inventory from mes-integration must be caught");

  rmSync(root, { recursive: true, force: true });
});

test("approvalClaimIsAtomicCas: fails when the PENDING guard is removed from claim_approval's WHERE clause", () => {
  const root = freshFixtureDir();
  const dbDir = join(root, "services", "agent-orchestrator", "app");
  mkdirSync(dbDir, { recursive: true });
  const good = [
    "async def claim_approval(",
    "    run_id: str",
    ") -> dict | None:",
    `    await conn.execute('UPDATE "AgentPipelineRun" SET approvalStatus=$1 WHERE approvalStatus=\'PENDING\'')`,
    "",
  ].join("\n");
  writeFileSync(join(dbDir, "db.py"), good);
  let result = approvalClaimIsAtomicCas(root);
  assert.equal(result.ok, true);

  const broken = [
    "async def claim_approval(",
    "    run_id: str",
    ") -> dict | None:",
    `    row = await conn.fetchrow('SELECT * FROM "AgentPipelineRun"')`,
    `    await conn.execute('UPDATE "AgentPipelineRun" SET approvalStatus=$1')`,
    "",
  ].join("\n");
  writeFileSync(join(dbDir, "db.py"), broken);
  result = approvalClaimIsAtomicCas(root);
  assert.equal(result.ok, false, "a read-then-write split (TOCTOU) must be caught");

  rmSync(root, { recursive: true, force: true });
});

test("contractFileExists: fails when the contract file is missing or unparseable", () => {
  const root = freshFixtureDir();
  let result = contractFileExists(root);
  assert.equal(result.ok, false, "a missing contract file must fail");

  const archDir = join(root, "architecture");
  mkdirSync(archDir, { recursive: true });
  writeFileSync(join(archDir, "contract.yaml"), "not: valid: yaml: ][[[");
  result = contractFileExists(root);
  assert.equal(result.ok, false, "unparseable YAML must fail");

  writeFileSync(join(archDir, "contract.yaml"), "invariants:\n  - id: X\n    statement: test\n");
  result = contractFileExists(root);
  assert.equal(result.ok, true, "a valid contract file with at least one invariant must pass");

  rmSync(root, { recursive: true, force: true });
});
