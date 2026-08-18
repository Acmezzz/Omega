import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionIds, summarizeTrace, WorkflowTraceWriter } from "../core/trace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("workflow trace", () => {
	it("appends and reloads execution events without payloads", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-trace-"));
		roots.push(root);
		const writer = new WorkflowTraceWriter(root);
		const ids = createExecutionIds();
		writer.append({ kind: "execution-start", ...ids, workflowId: "l2-demo", taskId: "task-1" });
		writer.append({ kind: "workflow-completed", ...ids, workflowId: "l2-demo", outcome: "in-progress", source: "tracker-completed" });
		const events = new WorkflowTraceWriter(root).read();
		expect(events).toHaveLength(2);
		expect(summarizeTrace(events).join("\n")).toContain("workflow-completed");
		expect(JSON.stringify(events)).not.toContain("payload");
	});
});
