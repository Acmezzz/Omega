import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../core/library/store.ts";
import { parseSynthesis } from "../core/extractor/pack.ts";
import type { L2Workflow } from "../core/library/types.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("synthesis parsing (cross-feature, three granularities)", () => {
	it("assigns a single task's L1/L2/L3 to different functional features", () => {
		const parsed = parseSynthesis(JSON.stringify({
			features: [
				{ id: "feature-calculation", label: "计算", description: "数值计算", aliases: [], levelSemantics: "L1/L2/L3 是执行粒度" },
				{ id: "feature-analysis", label: "分析", description: "结果分析", aliases: [] },
			],
			workflows: [
				{ id: "l1-compute", featureId: "feature-calculation", level: 1, intent: "数值计算", calls: [{ tool: "bash", argsTemplate: "运行计算" }], variants: [] },
				{ id: "l2-analyze", featureId: "feature-analysis", level: 2, intent: "分析结果", steps: [{ intent: "整理", action: { tool: "grep", argsTemplate: "筛选" } }] },
			],
		}));
		expect(parsed).not.toBeNull();
		expect(parsed!.features).toHaveLength(2);
		expect(parsed!.features[0].levelSemantics).toBe("L1/L2/L3 是执行粒度");
		const l1 = parsed!.workflows.find((w) => w.id === "l1-compute");
		const l2 = parsed!.workflows.find((w) => w.id === "l2-analyze");
		// cross-feature: same task contributed to two different features
		expect(l1?.featureId).toBe("feature-calculation");
		expect(l2?.featureId).toBe("feature-analysis");
		expect(l1?.level).toBe(1);
		expect(l2?.level).toBe(2);
	});

		it("drops workflows that reference an unknown feature and non-JSON input", () => {
			const parsed = parseSynthesis(JSON.stringify({
				features: [{ id: "feature-a", label: "A", description: "A", aliases: [] }],
				workflows: [
					{ id: "l1-known", featureId: "feature-a", level: 1, intent: "x", calls: [], variants: [] },
					{ id: "l1-orphan", featureId: "feature-missing", level: 1, intent: "y", calls: [], variants: [] },
				],
			}));
			expect(parsed!.workflows.map((w) => w.id)).toEqual(["l1-known"]);
			expect(parseSynthesis("not-json")).toBeNull();
		});

		it("rejects IDs that could escape workflow storage paths", () => {
			const parsed = parseSynthesis(JSON.stringify({
				features: [
					{ id: "feature-safe", label: "Safe", description: "Safe", aliases: [] },
					{ id: "feature-../outside", label: "Bad", description: "Bad", aliases: [] },
				],
				codeAssets: [
					{ id: "asset-safe", code: "echo ok" },
					{ id: "../outside", code: "echo bad" },
				],
				workflows: [
					{ id: "l1-safe", featureId: "feature-safe", level: 1, intent: "safe", calls: [], variants: [] },
					{ id: "../outside", featureId: "feature-safe", level: 1, intent: "bad", calls: [], variants: [] },
				],
			}));
			expect(parsed?.features.map((feature) => feature.id)).toEqual(["feature-safe"]);
			expect(parsed?.codeAssets.map((asset) => asset.id)).toEqual(["asset-safe"]);
			expect(parsed?.workflows.map((workflow) => workflow.id)).toEqual(["l1-safe"]);
		});
});

describe("functional catalog", () => {
	it("persists features, deduplicates members, and ignores unknown entries", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-catalog-"));
		roots.push(root);
		const store = WorkflowStore.createEmpty(root);
		const entity: L2Workflow = { id: "l2-research-docs", intent: "联网查阅整理文档", steps: [] };
		store.upsertEntity(entity, 2, "feature-web-research");
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
		store.upsertEntity({ id: "l2-a", intent: "A", steps: [] }, 2, "feature-a");
		store.upsertCatalogFeature({ id: "feature-a", label: "A", description: "A", aliases: [], entryIds: ["l2-a"] });
		store.upsertCatalogFeature({ id: "feature-b", label: "B", description: "B", aliases: [], entryIds: ["l2-a"] });
		const repaired = store.repairCatalog();
		expect(repaired.features).toHaveLength(2);
		expect(repaired.features.every((feature) => feature.entryIds.every((id) => id === "l2-a"))).toBe(true);
	});
});
