/**
 * V1: WorkflowStore state transitions and merging.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowStore } from "../core/library/store.ts";
import type { L1Template, L2Workflow } from "../core/library/types.ts";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jw-store-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function sampleL2(id = "l2-sample"): L2Workflow {
	return {
		id,
		intent: "示例工作流",
		steps: [{ intent: "一步", action: { tool: "bash", argsTemplate: "x" } }],
	};
}

function sampleL1(id = "l1-sample"): L1Template {
	return { id, intent: "示例模板", calls: [{ tool: "grep", argsTemplate: "p" }], variants: [] };
}

describe("V1: store transitions", () => {
	const FEATURE = "feature-authentication";

	it("new entity starts probation; second evidence promotes to active", () => {
		const store = WorkflowStore.createEmpty(join(root, "a"));
		const entry = store.upsertEntity(sampleL2(), 2, FEATURE);
		expect(entry.status).toBe("probation");
		expect(entry.evidence).toBe(1);
		const merged = store.upsertEntity(sampleL2(), 2, FEATURE);
		expect(merged.status).toBe("active");
		expect(merged.evidence).toBe(2);
		// persisted
		const reloaded = WorkflowStore.load(join(root, "a"));
		expect(reloaded.getEntry("l2-sample")?.status).toBe("active");
		expect(reloaded.getL2("l2-sample")?.steps).toHaveLength(1);
		// stored under features/<feature>/<id>.json
		expect(existsSync(join(root, "a", "features", FEATURE, "l2-sample.json"))).toBe(true);
	});

	it("escape pressure degrades active → probation → deprecated", () => {
		const store = WorkflowStore.createEmpty(join(root, "b"));
		const entry = store.upsertEntity(sampleL2("l2-degrade"), 2, FEATURE);
		store.upsertEntity(sampleL2("l2-degrade"), 2, FEATURE); // promote to active
		expect(store.getEntry("l2-degrade")?.status).toBe("active");
		// usage 4, escapes 4 → 8 > 4 → probation
		for (let i = 0; i < 4; i++) store.bumpEscape("l2-degrade");
		expect(store.getEntry("l2-degrade")?.status).toBe("probation");
		// continue to usage 8 → deprecated
		for (let i = 0; i < 4; i++) store.bumpEscape("l2-degrade");
		expect(store.getEntry("l2-degrade")?.status).toBe("deprecated");
		expect(store.escapeRate("l2-degrade")).toBe(1);
	});

	it("healthy usage without escapes never degrades", () => {
		const store = WorkflowStore.createEmpty(join(root, "c"));
		store.upsertEntity(sampleL2("l2-healthy"), 2, FEATURE);
		store.upsertEntity(sampleL2("l2-healthy"), 2, FEATURE);
		for (let i = 0; i < 10; i++) store.bumpUsage("l2-healthy");
		expect(store.getEntry("l2-healthy")?.status).toBe("active");
		expect(store.maybeDegrade("l2-healthy")).toBeNull();
	});

	it("mergeInto bumps evidence on the existing entry", () => {
		const store = WorkflowStore.createEmpty(join(root, "d"));
		store.upsertEntity(sampleL1(), 1, FEATURE);
		const before = store.getEntry("l1-sample")!.evidence;
			const candidate = sampleL1("l1-dup");
			candidate.intent = "更新后的用途";
			candidate.calls = [{ tool: "read", argsTemplate: "更新参数" }];
			const merged = store.mergeInto(candidate, "l1-sample", 1, FEATURE);
			expect(merged?.id).toBe("l1-sample");
			expect(store.getEntry("l1-sample")!.evidence).toBe(before + 1);
			expect(WorkflowStore.load(join(root, "d")).getL1("l1-sample")?.intent).toBe("更新后的用途");
			expect(WorkflowStore.load(join(root, "d")).getL1("l1-sample")?.calls[0].tool).toBe("read");

			const wrongLevel = store.mergeInto(sampleL2("l2-wrong"), "l1-sample", 2, FEATURE);
			expect(wrongLevel).toBeUndefined();
			expect(store.detectOrphans()).toEqual([]);
			// merge into unknown id falls back to a new probation entry

		const fallback = store.mergeInto(sampleL1("l1-fallback"), "l1-missing", 1, FEATURE);
		expect(fallback?.status).toBe("probation");
	});

	it("records evidence once and reloads the ledger", () => {
		const rootDir = join(root, "ledger");
		const store = WorkflowStore.createEmpty(rootDir);
		store.upsertEntity(sampleL1("l1-ledger"), 1, FEATURE);
		const before = store.getEntry("l1-ledger")!.evidence;
		expect(store.recordEvidence("l1-ledger", "source-1", { source: { taskId: "task", turnSeq: 1 } })).toBe(true);
		expect(store.recordEvidence("l1-ledger", "source-1")).toBe(false);
		expect(store.getEntry("l1-ledger")!.evidence).toBe(before + 1);
		const reloaded = WorkflowStore.load(rootDir);
		expect(reloaded.getEvidenceLedger().map((record) => record.evidenceKey)).toEqual(["source-1"]);
		expect(reloaded.getEntry("l1-ledger")!.evidence).toBe(before + 1);
	});

	it("can update an entity without counting evidence", () => {
		const store = WorkflowStore.createEmpty(join(root, "no-evidence"));
		store.upsertEntity(sampleL2("l2-update"), 2, FEATURE);
		const before = store.getEntry("l2-update")!.evidence;
		store.upsertEntity({ ...sampleL2("l2-update"), intent: "更新后的实体" }, 2, FEATURE, { countEvidence: false });
		expect(store.getEntry("l2-update")!.evidence).toBe(before);
		expect(store.getEntry("l2-update")!.intent).toBe("更新后的实体");
	});

	it("seed fixture is loadable from the repository", () => {
		const seedDir = fileURLToPath(new URL("../fixtures/workflows/seed", import.meta.url));
		const store = WorkflowStore.load(seedDir);
		const l2 = store.getL2("l2-fix-failing-test");
		expect(l2).not.toBeNull();
		expect(l2!.steps).toHaveLength(4);
		expect(l2!.steps[3].alternative).toBe("l1-locate-symbol");
		expect(store.getL1("l1-locate-symbol")!.calls).toHaveLength(2);
		expect(store.detectOrphans()).toEqual([]);
	});
});
