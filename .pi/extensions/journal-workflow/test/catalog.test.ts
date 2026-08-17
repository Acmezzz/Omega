import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../core/library/store.ts";
import { matchExistingCatalog, proposeNewCatalog } from "../core/extractor/pack.ts";
import type { L2Workflow } from "../core/library/types.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("functional catalog", () => {
	it("separates existing matching from new-category proposal", async () => {
		const existing = [{ id: "feature-code", label: "代码理解", description: "定位和理解代码", aliases: [] }];
		const entries = [{ id: "l2-docs", level: 2 as const, intent: "整理外部文档", excludes: [] }];
		const llm = new FakeLlm([
			JSON.stringify({ assignments: [], unmatchedEntryIds: ["l2-docs"] }),
			JSON.stringify({ newFeatures: [{ id: "feature-docs", label: "信息综合", description: "整理外部资料", aliases: [] }], assignments: [{ entryId: "l2-docs", featureIds: ["feature-docs"] }] }),
		]);
		const first = await matchExistingCatalog(existing, entries, llm);
		expect(first?.assignments).toEqual([]);
		expect(first?.unmatchedEntryIds).toEqual(["l2-docs"]);
		const second = await proposeNewCatalog(existing, entries, llm);
		expect(second?.newFeatures[0].id).toBe("feature-docs");
		expect(llm.calls[0].systemPrompt).toContain("Do not create");
		expect(llm.calls[1].systemPrompt).toContain("only for unmatched");
	});

	it("rejects malformed phase output", async () => {
		const llm = new FakeLlm(["not-json"]);
		expect(await matchExistingCatalog([], [{ id: "l1-a", level: 1, intent: "A", excludes: [] }], llm)).toBeNull();
	});

	it("persists features, deduplicates members, and ignores unknown entries", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-catalog-"));
		roots.push(root);
		const store = WorkflowStore.createEmpty(root);
		const entity: L2Workflow = { id: "l2-research-docs", intent: "联网查阅整理文档", steps: [] };
		store.upsertEntity(entity, 2);
		store.upsertCatalogFeature({
			id: "feature-web-research",
			label: "网络研究",
			description: "检索并整理外部资料",
			aliases: ["网页检索"],
			entryIds: ["l2-research-docs", "missing", "l2-research-docs"],
		});
		store.upsertCatalogFeature({
			id: "feature-web-research",
			label: "网络研究与文档综合",
			description: "跨来源研究",
			aliases: ["网页检索"],
			entryIds: ["l2-research-docs"],
		});
		expect(store.getCatalogFeatures()[0].entryIds).toEqual(["l2-research-docs"]);
		expect(JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")).features).toHaveLength(1);
		expect(WorkflowStore.load(root).getCatalogFeatures()[0].label).toBe("网络研究与文档综合");
	});

	it("repairs duplicate features and dangling references", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-catalog-"));
		roots.push(root);
		const store = WorkflowStore.createEmpty(root);
		store.upsertEntity({ id: "l2-a", intent: "A", steps: [] }, 2);
		store.upsertCatalogFeature({ id: "feature-a", label: "A", description: "A", aliases: [], entryIds: ["l2-a"] });
		store.upsertCatalogFeature({ id: "feature-b", label: "B", description: "B", aliases: [], entryIds: ["l2-a"] });
		const repaired = store.repairCatalog();
		expect(repaired.features).toHaveLength(2);
		expect(repaired.features.every((feature) => feature.entryIds.every((id) => id === "l2-a"))).toBe(true);
	});
});
