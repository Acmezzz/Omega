/** Optional, one-way interop contracts. No implementation imports either plugin. */
export interface WorkflowPriorSummary {
	id: string;
	intent: string;
	summary: string;
	reason: string;
}

export interface WorkflowPriorProvider {
	resolve(taskText: string): Promise<WorkflowPriorSummary | null>;
}

export interface ExplorationSelectionEvent {
	projectKey?: string;
	taskId: string;
	roundId: string;
	selectionId: string;
	selectedProposalIds: string[];
	combinedPlanSummary: string | null;
	reason?: string | null;
}
