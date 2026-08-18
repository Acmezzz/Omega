import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExplorationJournalLine,
	ExplorationJournalState,
	ExplorationRoundView,
	ExplorationSelection,
	ScoutRoundRecord,
} from "./types.ts";

function safeTaskSegment(taskId: string): string {
	return encodeURIComponent(taskId).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function explorationTaskDir(root: string, projectKey: string, taskId: string): string {
	return join(root, projectKey, safeTaskSegment(taskId));
}

function proposalIds(record: ScoutRoundRecord): Set<string> {
	return new Set(record.packet.runs.flatMap((run) => run.report?.proposals.map((proposal) => proposal.id) ?? []));
}

function readLineState(file: string): ExplorationJournalState {
	const rounds: ScoutRoundRecord[] = [];
	const selections: Array<{ roundId: string; selection: ExplorationSelection }> = [];
	let skippedLines = 0;
	let invalidSelections = 0;
	if (!existsSync(file)) return { rounds, views: [], currentRound: null, selections, skippedLines, invalidSelections };

	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		try {
			const parsed = JSON.parse(line) as ExplorationJournalLine;
			if (parsed.kind === "round" && parsed.record?.roundId) {
				rounds.push(parsed.record);
				continue;
			}
			if (parsed.kind === "selection" && typeof parsed.roundId === "string" && parsed.selection) {
				const round = rounds.find((record) => record.roundId === parsed.roundId);
				const selectedIds = parsed.selection.selectedProposalIds;
				if (!round || new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !id.trim() || !proposalIds(round).has(id))) {
					invalidSelections += 1;
					continue;
				}
				selections.push({ roundId: parsed.roundId, selection: parsed.selection });
				continue;
			}
			skippedLines += 1;
		} catch {
			skippedLines += 1;
		}
	}

	const latest = new Map<string, ExplorationSelection>();
	for (const item of selections) latest.set(item.roundId, item.selection);
	const views: ExplorationRoundView[] = rounds.map((round) => {
		const selection = latest.get(round.roundId) ?? null;
		return {
			...round,
			selection,
			adoptedProposalIds: selection?.selectedProposalIds ?? round.adoptedProposalIds,
			...(selection?.combinedPlanSummary ? { combinedPlanSummary: selection.combinedPlanSummary } : {}),
		};
	});
	return {
		rounds,
		views,
		currentRound: views.at(-1) ?? null,
		selections,
		skippedLines,
		invalidSelections,
	};
}

export class ExplorationJournal {
	private readonly dir: string;
	constructor(root: string, readonly projectKey: string, readonly taskId: string) {
		this.dir = explorationTaskDir(root, projectKey, taskId);
		mkdirSync(this.dir, { recursive: true });
	}

	appendRound(record: ScoutRoundRecord): void {
		this.append({ kind: "round", record });
	}

	appendSelection(roundId: string, selection: ExplorationSelection): void {
		this.append({ kind: "selection", roundId, selection });
	}

	readState(): ExplorationJournalState {
		return readLineState(join(this.dir, "rounds.jl"));
	}

	readRounds(): ScoutRoundRecord[] {
		return this.readState().rounds;
	}

	private append(line: ExplorationJournalLine): void {
		appendFileSync(join(this.dir, "rounds.jl"), `${JSON.stringify(line)}\n`);
	}
}
