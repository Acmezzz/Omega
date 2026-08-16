/** Shared task identity helpers; persistence ownership stays with each plugin. */
export function projectKeyFromCwd(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/^\/+/, "");
	return `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface TaskIdentity {
	projectKey: string;
	taskId: string;
}
