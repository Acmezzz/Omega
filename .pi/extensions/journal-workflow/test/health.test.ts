import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkProjectHealth } from "../core/health.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("workflow health", () => {
	it("returns a read-only healthy report without payload text", () => {
		const root = mkdtempSync(join(process.cwd(), "health-test-"));
		roots.push(root);
		const report = checkProjectHealth({ journalsRoot: join(root, "journals"), backupsRoot: join(root, "backups"), workflowsRoot: join(root, "workflows"), projectKey: "project" });
		expect(report.status).toBe("ok");
		expect(JSON.stringify(report)).not.toContain("thinking");
		expect(JSON.stringify(report)).not.toContain("payload");
	});

	it("checks project-specific manifests and the evidence ledger without exposing content", () => {
		const root = mkdtempSync(join(process.cwd(), "health-manifest-test-"));
		roots.push(root);
		const workflowsRoot = join(root, "workflows");
		mkdirSync(join(workflowsRoot, "manifests"), { recursive: true });
		writeFileSync(join(workflowsRoot, "manifests", "project.json"), JSON.stringify({ version: 1, projectKey: "other" }));
		writeFileSync(join(workflowsRoot, ".evidence-ledger.json"), JSON.stringify({ version: 1, entries: [{ evidenceKey: "dup", entryId: "missing" }, { evidenceKey: "dup", entryId: "missing" }] }));
		const report = checkProjectHealth({ journalsRoot: join(root, "journals"), backupsRoot: join(root, "backups"), workflowsRoot, projectKey: "project" });
		expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["EXTRACTION_MANIFEST_INVALID", "EVIDENCE_LEDGER_DUPLICATE_KEY", "EVIDENCE_LEDGER_ORPHAN"]));
		expect(JSON.stringify(report)).not.toContain("dup");
	});
});
