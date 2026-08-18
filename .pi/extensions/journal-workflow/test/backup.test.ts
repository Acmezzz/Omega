import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupReader, BackupWriter } from "../core/journal/backup.ts";
import { buildRestorePlan } from "../core/journal/restore.ts";
import { truncateWithMeta } from "../core/journal/writer.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("raw journal backup and fragments", () => {
	it("keeps the complete payload and creates indexed overlapping fragments", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-backup-"));
		roots.push(root);
		const writer = new BackupWriter(root, "project", "task", "session", { fragmentSize: 100, fragmentOverlap: 20 });
		const longResult = `${"a".repeat(90)}\n${"b".repeat(90)}\n${"c".repeat(90)}`;
		const result = writer.appendEvent("tool_execution_end", { content: longResult, hidden: { answer: 42 } }, {
			turnSeq: 2,
			toolCallId: "call-1",
			texts: [{ field: "tool.result", text: longResult }],
		});
		const eventLine = JSON.parse(readFileSync(join(writer.dir, "events.jl"), "utf8")) as { payload: { hidden: { answer: number } } };
		expect(eventLine.payload.hidden.answer).toBe(42);
		expect(result.fragmentIds["tool.result"].length).toBeGreaterThan(1);
		const index = writer.getIndex();
		expect(index.fragments.every((fragment) => !("text" in fragment))).toBe(true);
		const fragments = writer.reader().getFragments({ fragmentIds: result.fragmentIds["tool.result"].slice(0, 2), maxChars: 3000 });
		expect(fragments[0].text.length).toBeGreaterThan(0);
		expect(fragments[0].turnSeq).toBe(2);
	});

	it("uses tail-first IDs and enforces sensitive/budget access", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-backup-"));
		roots.push(root);
		const writer = new BackupWriter(root, "p", "t", "s", { fragmentSize: 100, fragmentOverlap: 0 });
		const result = writer.appendEvent("assistant_message", { content: "x" }, {
			turnSeq: 1,
			texts: [{ field: "assistantThinking", text: "secret reasoning" , sensitivity: "restricted" }],
		});
		const id = result.fragmentIds.assistantThinking[0];
		expect(id).toContain("m");
		expect(() => writer.reader().getFragments({ fragmentIds: [id] })).toThrow(/sensitive/);
		expect(writer.reader({ allowSensitive: true }).getFragments({ fragmentIds: [id], allowSensitive: true })[0].text).toContain("secret");
		expect(() => writer.reader({ allowSensitive: true }).getFragments({ fragmentIds: [id, "missing"], allowSensitive: true })).toThrow(/unknown/);
	});

	it("scans backup events and builds an idempotent restore plan", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-restore-"));
		roots.push(root);
		const writer = new BackupWriter(root, "project", "task", "session");
		writer.appendEvent("user_message", { role: "user", content: "恢复任务" }, { turnSeq: 1 });
		writer.appendEvent("turn_end", { message: { stopReason: "stop" } }, { turnSeq: 1 });
		const reader = new BackupReader(writer.dir);
		const plan = buildRestorePlan(reader.scanEvents(), "project", "task", new Set());
		expect(plan.eventsValid).toBe(2);
		expect(plan.turnsEligible).toBe(1);
		expect(plan.turns[0].extractedAt).toBeUndefined();
		const second = buildRestorePlan(reader.scanEvents(), "project", "task", new Set([1]));
		expect(second.turnsEligible).toBe(0);
		expect(second.status).toBe("no-op");
	});

	it("rebuilds a missing index and keeps head-tail truncation metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "jw-backup-"));
		roots.push(root);
		const writer = new BackupWriter(root, "p", "t", "s");
		writer.appendEvent("user_message", { content: "hello" }, { texts: [{ field: "userInput", text: "hello" }] });
		const indexPath = join(writer.dir, "index.json");
		writeFileSync(indexPath, "broken");
		const reader = new BackupReader(writer.dir);
		expect(reader.listFragments()).toHaveLength(1);
		const bounded = truncateWithMeta("0123456789".repeat(20), 20);
		expect(bounded.meta?.strategy).toBe("head-tail");
		expect(bounded.text).toContain("truncated");
	});
});
