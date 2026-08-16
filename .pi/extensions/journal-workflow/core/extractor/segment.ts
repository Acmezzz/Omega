/**
 * Programmatic segmentation & pattern mining — zero randomness.
 * Structural decisions (boundaries, co-occurrence counts, skeleton alignment)
 * are rules; the LLM only labels semantics later in pack.ts.
 */
import type { TurnRecord } from "../journal/types.ts";

/** Tool sequence of one turn (in execution order). */
export function toolSequenceOfTurn(turn: TurnRecord): string[] {
	return turn.toolCalls.map((tc) => tc.tool);
}

/** Count adjacent n-grams across sequences. Key format: "grep|read". */
export function coOccurrence(sequences: string[][], n = 2): Map<string, number> {
	const counts = new Map<string, number>();
	for (const seq of sequences) {
		const seenInSeq = new Set<string>();
		for (let i = 0; i + n <= seq.length; i++) {
			const gram = seq.slice(i, i + n).join("|");
			// Count each n-gram at most once per sequence (task), not per repetition.
			if (seenInSeq.has(gram)) continue;
			seenInSeq.add(gram);
			counts.set(gram, (counts.get(gram) ?? 0) + 1);
		}
	}
	return counts;
}

export interface RecurringPattern {
	tools: string[];
	count: number;
}

/** Adjacent patterns occurring in at least minCount distinct sequences. */
export function findRecurringPatterns(sequences: string[][], n: number, minCount: number): RecurringPattern[] {
	const counts = coOccurrence(sequences, n);
	const out: RecurringPattern[] = [];
	for (const [gram, count] of counts) {
		if (count >= minCount) {
			out.push({ tools: gram.split("|"), count });
		}
	}
	return out.sort((a, b) => b.count - a.count);
}

/** Classic LCS on string arrays. */
export function longestCommonSubsequence(a: string[], b: string[]): string[] {
	const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			if (a[i] === b[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push(a[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return out;
}

/** Multi-sequence skeleton: fold LCS across sequences. */
export function alignSkeletons(sequences: string[][]): string[] {
	if (sequences.length === 0) return [];
	let skeleton = sequences[0];
	for (const seq of sequences.slice(1)) {
		skeleton = longestCommonSubsequence(skeleton, seq);
		if (skeleton.length === 0) break;
	}
	return skeleton;
}
