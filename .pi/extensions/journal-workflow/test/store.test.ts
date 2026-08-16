/**
 * V1: WorkflowStore state transitions and merging.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
	it("new entity starts probation; second evidence promotes to active", () => {
		const store = WorkflowStore.createEmpty(join(root, "a"));
		const entry = store.upsertEntity(sampleL2(), 2);
		expect(entry.status).toBe("probation");
		expect(entry.evidence).toBe(1);
		const merged = store.upsertEntity(sampleL2(), 2);
		expect(merged.status).toBe("active");
		expect(merged.evidence).toBe(2);
		// persisted
		const reloaded = WorkflowStore.load(join(root, "a"));
		expect(reloaded.getEntry("l2-sample")?.status).toBe("active");
		expect(reloaded.getL2("l2-sample")?.steps).toHaveLength(1);
	});

	it("escape pressure degrades active → probation → deprecated", () => {
		const store = WorkflowStore.createEmpty(join(root, "b"));
		const entry = store.upsertEntity(sampleL2("l2-degrade"), 2);
		store.upsertEntity(sampleL2("l2-degrade"), 2); // promote to active
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
		store.upsertEntity(sampleL2("l2-healthy"), 2);
		store.upsertEntity(sampleL2("l2-healthy"), 2);
		for (let i = 0; i < 10; i++) store.bumpUsage("l2-healthy");
		expect(store.getEntry("l2-healthy")?.status).toBe("active");
		expect(store.maybeDegrade("l2-healthy")).toBeNull();
	});

	it("mergeInto bumps evidence on the existing entry", () => {
		const store = WorkflowStore.createEmpty(join(root, "d"));
		store.upsertEntity(sampleL1(), 1);
		const before = store.getEntry("l1-sample")!.evidence;
		const merged = store.mergeInto(sampleL1("l1-dup"), "l1-sample", 1);
		expect(merged?.id).toBe("l1-sample");
		expect(store.getEntry("l1-sample")!.evidence).toBe(before + 1);
		// merge into unknown id falls back to a new probation entry
		const fallback = store.mergeInto(sampleL1("l1-fallback"), "l1-missing", 1);
		expect(fallback?.status).toBe("probation");
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
