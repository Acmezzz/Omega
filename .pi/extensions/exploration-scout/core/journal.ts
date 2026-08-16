import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExplorationJournalLine, ExplorationSelection, ScoutRoundRecord } from "./types.ts";

export function explorationTaskDir(root: string, projectKey: string, taskId: string): string {
	return join(root, projectKey, taskId);
}

export class ExplorationJournal {
	private readonly dir: string;
	constructor(root: string, private readonly projectKey: string, private readonly taskId: string) {
		this.dir = explorationTaskDir(root, projectKey, taskId);
		mkdirSync(this.dir, { recursive: true });
	}

	appendRound(record: ScoutRoundRecord): void {
		this.append({ kind: "round", record });
	}

	appendSelection(roundId: string, selection: ExplorationSelection): void {
		this.append({ kind: "selection", roundId, selection });
	}

	readRounds(): ScoutRoundRecord[] {
		const file = join(this.dir, "rounds.jl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
			try {
				const parsed = JSON.parse(line) as ExplorationJournalLine;
				return parsed.kind === "round" ? [parsed.record] : [];
			} catch {
				return [];
			}
		});
	}

	private append(line: ExplorationJournalLine): void {
		appendFileSync(join(this.dir, "rounds.jl"), `${JSON.stringify(line)}\n`);
	}
}
