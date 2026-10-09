#!/usr/bin/env node
// Stage 09 (Architecture Contract and CI Enforcement) — lightweight,
// dependency-free (beyond js-yaml, already vendored transitively) static
// checks for the invariants in architecture/contract.yaml that are
// actually mechanically verifiable. Deliberately NOT a full AST-based
// linter: regex/text scanning is practical and sufficient for the real
// violations this repo has actually had (see each check's own comment for
// which real bug it guards against). Every check is a pure function of
// `repoRoot` so check-contract.test.mjs can point them at synthetic
// fixture directories instead of ever needing to introduce a real
// violation into this live repository.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import yaml from "js-yaml";

export function walk(dir, { skipDirs = new Set(["node_modules", ".git", "dist", "build", "generated"]) } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, { skipDirs }));
    else out.push(full);
  }
  return out;
}

// --- B2: no LLM SDK import outside agent-orchestrator ---
// Real invariant this guards: the stage's own explicit "no LLM code under
// scheduling-service or deterministic scheduling engine." Scans every .py
// and .ts file outside services/agent-orchestrator for an LLM SDK import.
export function noLlmOutsideAgentOrchestrator(repoRoot) {
  const servicesDir = join(repoRoot, "services");
  const violations = [];
  const llmImportPattern = /\b(ChatGroq|from\s+groq\b|import\s+groq\b|ChatOpenAI|from\s+openai\b|import\s+openai\b|anthropic\.Anthropic|from\s+anthropic\b)/;
  for (const file of walk(servicesDir)) {
    if (!/\.(py|ts)$/.test(file)) continue;
    if (relative(repoRoot, file).startsWith(join("services", "agent-orchestrator"))) continue;
    const content = readFileSync(file, "utf8");
    if (llmImportPattern.test(content)) {
      violations.push(relative(repoRoot, file));
    }
  }
  return { ok: violations.length === 0, violations };
}

// --- F2: ResourceReservation exclusion constraint present ---
// Real invariant: the Postgres-level EXCLUDE USING gist constraint that
// prevents overlapping reservations must never be silently dropped by a
// later migration without a replacement.
export function exclusionConstraintPresent(repoRoot) {
  const migrationsDir = join(repoRoot, "packages", "domain", "prisma", "migrations");
  const files = walk(migrationsDir).filter((f) => f.endsWith(".sql"));
  const created = files.some((f) => /EXCLUDE USING gist/i.test(readFileSync(f, "utf8")));
  const dropped = files.some((f) => {
    const content = readFileSync(f, "utf8");
    return /DROP CONSTRAINT/i.test(content) && /resource_?reservation/i.test(content) && /exclusion|excl/i.test(content);
  });
  return { ok: created && !dropped, created, dropped };
}

// --- F1: required enterpriseId columns present on tenant-owned models ---
// Only models that are DIRECTLY enterprise-scoped per Stage 02's own
// established convention (commercial/order-facing entities). Shop-floor
// entities (Machine, MaintenanceOrder, ScheduledOperation, ...) are
// deliberately scoped INDIRECTLY via their plant/machine hierarchy
// instead — that's an established, intentional pattern, not a gap, and
// is out of scope for this check.
const TENANT_SCOPED_MODELS = ["Customer", "SalesOrder", "ProductionOrder", "AgentPipelineRun", "AuditLog", "IdempotencyKey"];

export function requiredEnterpriseIdColumnsPresent(repoRoot) {
  const schemaPath = join(repoRoot, "packages", "domain", "prisma", "schema.prisma");
  const schema = readFileSync(schemaPath, "utf8");
  const missing = [];
  for (const model of TENANT_SCOPED_MODELS) {
    const match = schema.match(new RegExp(`model\\s+${model}\\s*\\{([^}]*)\\}`, "s"));
    if (!match) {
      missing.push(`${model} (model not found)`);
      continue;
    }
    if (!/\benterpriseId\b/.test(match[1])) {
      missing.push(`${model} (no enterpriseId field)`);
    }
  }
  return { ok: missing.length === 0, missing };
}

// --- E1: IdempotencyKey schema present ---
export function idempotencyKeySchemaPresent(repoRoot) {
  const schemaPath = join(repoRoot, "packages", "domain", "prisma", "schema.prisma");
  const schema = readFileSync(schemaPath, "utf8");
  const match = schema.match(/model\s+IdempotencyKey\s*\{([^}]*)\}/s);
  if (!match) return { ok: false, reason: "IdempotencyKey model not found" };
  const body = match[1];
  const requiredFields = ["enterpriseId", "key", "operation", "requestHash", "statusCode"];
  const missingFields = requiredFields.filter((f) => !new RegExp(`\\b${f}\\b`).test(body));
  const hasUniqueConstraint = /@@unique\(\[enterpriseId,\s*key,\s*operation\]\)/.test(body);
  return { ok: missingFields.length === 0 && hasUniqueConstraint, missingFields, hasUniqueConstraint };
}

// --- A1: no unexpected SalesOrder writers ---
// Real invariant: exactly one canonical SalesOrder creation path
// (order-service), plus the one documented exception (erp-integration,
// the ERP-ingestion boundary — see known_exceptions in contract.yaml).
// Any OTHER service creating SalesOrder rows directly via Prisma is an
// undocumented second creation path — the exact kind of drift this check
// exists to catch.
const ALLOWED_SALES_ORDER_WRITERS = new Set(["order-service", "erp-integration"]);

export function noUnexpectedSalesOrderWriters(repoRoot) {
  const servicesDir = join(repoRoot, "services");
  const violations = [];
  if (!existsSync(servicesDir)) return { ok: true, violations };
  for (const serviceName of readdirSync(servicesDir)) {
    if (ALLOWED_SALES_ORDER_WRITERS.has(serviceName)) continue;
    const serviceDir = join(servicesDir, serviceName);
    if (!statSync(serviceDir).isDirectory()) continue;
    for (const file of walk(serviceDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const content = readFileSync(file, "utf8");
      if (/prisma\.salesOrder\.(create|upsert)\(/.test(content)) {
        violations.push(relative(repoRoot, file));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

// --- G1: no cross-domain writes into Inventory/InventoryMovement ---
// Guards the exact regression Stage 06 fixed: mes-integration (or any
// other non-owning service) writing inventory-service's tables directly.
export function noCrossDomainInventoryWrites(repoRoot) {
  const servicesDir = join(repoRoot, "services");
  const violations = [];
  if (!existsSync(servicesDir)) return { ok: true, violations };
  for (const serviceName of readdirSync(servicesDir)) {
    if (serviceName === "inventory-service") continue;
    const serviceDir = join(servicesDir, serviceName);
    if (!statSync(serviceDir).isDirectory()) continue;
    for (const file of walk(serviceDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const content = readFileSync(file, "utf8");
      if (/prisma\.inventory(Movement)?\.(create|update|upsert|delete)\(/.test(content)) {
        violations.push(relative(repoRoot, file));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

// --- D1: approval claim is an atomic CAS ---
// Guards against claim_approval regressing from an atomic
// UPDATE ... WHERE approvalStatus = 'PENDING' into a read-then-write
// (TOCTOU race re-introduced).
export function approvalClaimIsAtomicCas(repoRoot) {
  const dbPath = join(repoRoot, "services", "agent-orchestrator", "app", "db.py");
  if (!existsSync(dbPath)) return { ok: false, reason: "app/db.py not found" };
  const content = readFileSync(dbPath, "utf8");
  const fnMatch = content.match(/async def claim_approval\([^)]*\)\s*(?:->[^:]*)?:([\s\S]*?)(?=\nasync def |$)/);
  if (!fnMatch) return { ok: false, reason: "claim_approval function not found" };
  const body = fnMatch[1];
  const hasUpdate = /UPDATE\s+"?AgentPipelineRun"?/i.test(body);
  const hasPendingGuard = /approvalStatus['"]?\s*=\s*['"]PENDING['"]/i.test(body) || /approvalStatus.*PENDING/i.test(body);
  return { ok: hasUpdate && hasPendingGuard, hasUpdate, hasPendingGuard };
}

// --- H2: contract file exists and parses ---
export function contractFileExists(repoRoot) {
  const contractPath = join(repoRoot, "architecture", "contract.yaml");
  if (!existsSync(contractPath)) return { ok: false, reason: "architecture/contract.yaml not found" };
  try {
    const parsed = yaml.load(readFileSync(contractPath, "utf8"));
    const ok = Array.isArray(parsed?.invariants) && parsed.invariants.length > 0;
    return { ok, invariantCount: parsed?.invariants?.length ?? 0 };
  } catch (error) {
    return { ok: false, reason: `failed to parse YAML: ${String(error)}` };
  }
}

export const CHECKS = {
  no_llm_outside_agent_orchestrator: noLlmOutsideAgentOrchestrator,
  exclusion_constraint_present: exclusionConstraintPresent,
  required_enterprise_id_columns_present: requiredEnterpriseIdColumnsPresent,
  idempotency_key_schema_present: idempotencyKeySchemaPresent,
  no_unexpected_sales_order_writers: noUnexpectedSalesOrderWriters,
  no_cross_domain_inventory_writes: noCrossDomainInventoryWrites,
  approval_claim_is_atomic_cas: approvalClaimIsAtomicCas,
  contract_file_exists: contractFileExists,
};

function formatViolation(invariantId, checkName, result) {
  const fixHints = {
    no_llm_outside_agent_orchestrator: "Move the LLM call into services/agent-orchestrator, or remove it — no other service may import an LLM SDK.",
    exclusion_constraint_present: "Restore the EXCLUDE USING gist constraint on ResourceReservation (see migration 20260723143338_resource_reservation_exclusion) — do not drop it without a replacement.",
    required_enterprise_id_columns_present: "Add an enterpriseId field to the listed model(s) in packages/domain/prisma/schema.prisma.",
    idempotency_key_schema_present: "Restore the IdempotencyKey model's required fields and its @@unique([enterpriseId, key, operation]) constraint.",
    no_unexpected_sales_order_writers: "Remove the direct prisma.salesOrder.create/upsert call from this service — route it through order-service's POST /sales-orders, or add it to ALLOWED_SALES_ORDER_WRITERS with a documented reason in contract.yaml's known_exceptions.",
    no_cross_domain_inventory_writes: "Route this write through inventory-service's HTTP API instead of writing Inventory/InventoryMovement directly via Prisma.",
    approval_claim_is_atomic_cas: "claim_approval must remain a single atomic UPDATE ... WHERE approvalStatus='PENDING' — do not split into a separate read-then-write.",
    contract_file_exists: "Restore architecture/contract.yaml.",
  };
  return `ARCHITECTURE VIOLATION: ${checkName} failed for invariant ${invariantId} — ${JSON.stringify(result)}. Fix: ${fixHints[checkName] ?? "see architecture/contract.yaml"}`;
}

export function runAllChecks(repoRoot) {
  const contractPath = join(repoRoot, "architecture", "contract.yaml");
  const contract = yaml.load(readFileSync(contractPath, "utf8"));
  const results = [];
  for (const invariant of contract.invariants) {
    if (!invariant.automated_check) {
      results.push({ invariantId: invariant.id, checkName: null, status: "MANUAL", ok: true });
      continue;
    }
    const checkFn = CHECKS[invariant.automated_check];
    if (!checkFn) {
      results.push({ invariantId: invariant.id, checkName: invariant.automated_check, status: "CHECK_NOT_FOUND", ok: false, result: null });
      continue;
    }
    const result = checkFn(repoRoot);
    results.push({ invariantId: invariant.id, checkName: invariant.automated_check, status: result.ok ? "PASS" : "FAIL", ok: result.ok, result });
  }
  return results;
}

function main() {
  const repoRoot = join(import.meta.dirname, "..");
  const results = runAllChecks(repoRoot);
  let failed = false;
  for (const r of results) {
    if (r.status === "MANUAL") {
      console.log(`MANUAL   ${r.invariantId} — no automated check (see contract.yaml for manual_verification)`);
    } else if (r.ok) {
      console.log(`PASS     ${r.invariantId} (${r.checkName})`);
    } else {
      failed = true;
      console.error(formatViolation(r.invariantId, r.checkName, r.result));
    }
  }
  if (failed) {
    console.error("\nArchitecture contract check FAILED.");
    process.exit(1);
  }
  console.log("\nArchitecture contract check passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
