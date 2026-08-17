/**
 * WorkflowStore: registry + entity files under workflowsRoot.
 * {root}/registry.json, {root}/atoms/<id>.json, {root}/workflows/<id>.json,
 * {root}/orchestrations/<id>.json
 *
 * Evolution rules (V1):
 * - evidence >= 2 → active (from probation)
 * - usage >= 4 && escapes * 2 > usage → active → probation
 * - probation && usage >= 8 && escapes * 2 > usage → deprecated
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type LibraryEntity,
	type L1Template,
	type L2Workflow,
	type L3Orchestration,
	type RegistryEntry,
	type CatalogFeature,
	type CatalogFile,
	entityDir,
	isL1,
	isL2,
	isL3,
} from "./types.ts";

export const PROMOTION_EVIDENCE = 2;
export const DEGRADE_MIN_USAGE = 4;
export const DEPRECATE_MIN_USAGE = 8;

export interface RegistryFile {
	entries: RegistryEntry[];
}

const EMPTY_CATALOG: CatalogFile = { version: 1, updatedAt: "", features: [] };

function readCatalog(rootDir: string): CatalogFile {
	const path = join(rootDir, "catalog.json");
	if (!existsSync(path)) return { ...EMPTY_CATALOG, features: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CatalogFile>;
		if (!Array.isArray(parsed.features)) return { ...EMPTY_CATALOG, features: [] };
		return {
			version: 1,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
			features: parsed.features.filter((feature): feature is CatalogFeature =>
				!!feature && typeof feature === "object" && typeof feature.id === "string" &&
					typeof feature.label === "string" && typeof feature.description === "string" &&
					Array.isArray(feature.aliases) && Array.isArray(feature.entryIds),
			),
		};
	} catch {
		return { ...EMPTY_CATALOG, features: [] };
	}
}

export class WorkflowStore {
	private readonly rootDir: string;
	private entries: RegistryEntry[];
	private catalog: CatalogFile;

	private constructor(rootDir: string, entries: RegistryEntry[], catalog: CatalogFile) {
		this.rootDir = rootDir;
		this.entries = entries;
		this.catalog = catalog;
	}

	static load(rootDir: string): WorkflowStore {
		const registryPath = join(rootDir, "registry.json");
		let entries: RegistryEntry[] = [];
		if (existsSync(registryPath)) {
			try {
				const parsed = JSON.parse(readFileSync(registryPath, "utf-8")) as RegistryFile;
				entries = Array.isArray(parsed.entries) ? parsed.entries : [];
			} catch {
				entries = [];
			}
		}
		return new WorkflowStore(rootDir, entries, readCatalog(rootDir));
	}

	/** Create an empty store at root (used by seeds/tests). */
	static createEmpty(rootDir: string): WorkflowStore {
		mkdirSync(join(rootDir, "atoms"), { recursive: true });
		mkdirSync(join(rootDir, "workflows"), { recursive: true });
		mkdirSync(join(rootDir, "orchestrations"), { recursive: true });
		return new WorkflowStore(rootDir, [], { ...EMPTY_CATALOG, features: [] });
	}

	getRegistry(): RegistryEntry[] {
		return [...this.entries];
	}

	getCatalog(): CatalogFile {
		return {
			...this.catalog,
			features: this.catalog.features.map((feature) => ({ ...feature, aliases: [...feature.aliases], entryIds: [...feature.entryIds] })),
		};
	}

	/** Return catalog features with registry references that still exist. */
	getCatalogFeatures(): CatalogFeature[] {
		const known = new Set(this.entries.map((entry) => entry.id));
		return this.getCatalog().features.map((feature) => ({
			...feature,
			entryIds: feature.entryIds.filter((id) => known.has(id)),
		}));
	}

	/** Add a feature or merge its members idempotently. Unknown entry IDs are ignored. */
	upsertCatalogFeature(feature: Omit<CatalogFeature, "updatedAt"> & { updatedAt?: string }): CatalogFeature {
		const now = new Date().toISOString();
		const known = new Set(this.entries.map((entry) => entry.id));
		const incomingIds = feature.entryIds.filter((id) => known.has(id));
		const existing = this.catalog.features.find((item) => item.id === feature.id);
		if (existing) {
			existing.label = feature.label || existing.label;
			existing.description = feature.description || existing.description;
			existing.aliases = [...new Set([...existing.aliases, ...feature.aliases])];
			existing.entryIds = [...new Set([...existing.entryIds, ...incomingIds])];
			existing.updatedAt = now;
		} else {
			this.catalog.features.push({
				id: feature.id,
				label: feature.label,
				description: feature.description,
				aliases: [...new Set(feature.aliases)],
				entryIds: [...new Set(incomingIds)],
				updatedAt: feature.updatedAt ?? now,
			});
		}
		this.catalog.updatedAt = now;
		this.saveCatalog();
		return this.catalog.features.find((item) => item.id === feature.id)!;
	}

	/** Remove dangling registry references and duplicate members, then persist. */
	repairCatalog(): CatalogFile {
		const known = new Set(this.entries.map((entry) => entry.id));
		const seenFeatures = new Set<string>();
		this.catalog.features = this.catalog.features.filter((feature) => {
			if (seenFeatures.has(feature.id)) return false;
			seenFeatures.add(feature.id);
			feature.entryIds = [...new Set(feature.entryIds.filter((id) => known.has(id)))];
			feature.aliases = [...new Set(feature.aliases)];
			return true;
		});
		this.catalog.updatedAt = new Date().toISOString();
		this.saveCatalog();
		return this.getCatalog();
	}

	getEntry(id: string): RegistryEntry | undefined {
		return this.entries.find((e) => e.id === id);
	}

	getEntity(id: string): LibraryEntity | undefined {
		const entry = this.getEntry(id);
		if (!entry) return undefined;
		const path = join(this.rootDir, entityDir(entry.level), `${id}.json`);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as LibraryEntity;
		} catch {
			return undefined;
		}
	}

	getL1(id: string): L1Template | undefined {
		const entity = this.getEntity(id);
		return entity && isL1(entity) ? entity : undefined;
	}

	getL2(id: string): L2Workflow | undefined {
		const entity = this.getEntity(id);
		return entity && isL2(entity) ? entity : undefined;
	}

	getL3(id: string): L3Orchestration | undefined {
		const entity = this.getEntity(id);
		return entity && isL3(entity) ? entity : undefined;
	}

	listEntities(level?: 1 | 2 | 3): LibraryEntity[] {
		const out: LibraryEntity[] = [];
		for (const entry of this.entries) {
			if (level && entry.level !== level) continue;
			const entity = this.getEntity(entry.id);
			if (entity) out.push(entity);
		}
		return out;
	}

	/** Insert or merge an entity: same id → evidence++ merge; new → probation entry. */
	upsertEntity(entity: LibraryEntity, level: 1 | 2 | 3): RegistryEntry {
		const existing = this.getEntry(entity.id);
		const now = new Date().toISOString();
		if (existing) {
			existing.evidence += 1;
			existing.updatedAt = now;
			if (existing.status === "probation" && existing.evidence >= PROMOTION_EVIDENCE) {
				existing.status = "active";
			}
			this.writeEntity(entity, level);
			this.save();
			return existing;
		}
		const entry: RegistryEntry = {
			id: entity.id,
			level,
			intent: entity.intent,
			excludes: entity.excludes,
			evidence: 1,
			usage: 0,
			escapes: 0,
			status: "probation",
			updatedAt: now,
		};
		this.entries.push(entry);
		this.writeEntity(entity, level);
		this.save();
		return entry;
	}

	/** Merge by intent similarity: caller supplies the existing id to merge into. */
	mergeInto(newEntity: LibraryEntity, existingId: string, level: 1 | 2 | 3): RegistryEntry | undefined {
		const target = this.getEntry(existingId);
		if (!target) return this.upsertEntity(newEntity, level);
		target.evidence += 1;
		target.updatedAt = new Date().toISOString();
		if (target.status === "probation" && target.evidence >= PROMOTION_EVIDENCE) target.status = "active";
		this.save();
		return target;
	}

	bumpEvidence(id: string, n = 1): void {
		const entry = this.getEntry(id);
		if (!entry) return;
		entry.evidence += n;
		entry.updatedAt = new Date().toISOString();
		if (entry.status === "probation" && entry.evidence >= PROMOTION_EVIDENCE) entry.status = "active";
		this.save();
	}

	bumpUsage(id: string): void {
		const entry = this.getEntry(id);
		if (!entry) return;
		entry.usage += 1;
		entry.updatedAt = new Date().toISOString();
		this.save();
	}

	bumpEscape(id: string): void {
		const entry = this.getEntry(id);
		if (!entry) return;
		entry.escapes += 1;
		entry.usage += 1; // an escape is also a usage
		entry.updatedAt = new Date().toISOString();
		this.maybeDegrade(id);
		this.save();
	}

	/** Apply degradation transitions; returns the new status when changed. */
	maybeDegrade(id: string): RegistryEntry["status"] | null {
		const entry = this.getEntry(id);
		if (!entry) return null;
		const overEscape = entry.escapes * 2 > entry.usage;
		if (entry.status === "active" && entry.usage >= DEGRADE_MIN_USAGE && overEscape) {
			entry.status = "probation";
			entry.updatedAt = new Date().toISOString();
			return "probation";
		}
		if (entry.status === "probation" && entry.usage >= DEPRECATE_MIN_USAGE && overEscape) {
			entry.status = "deprecated";
			entry.updatedAt = new Date().toISOString();
			return "deprecated";
		}
		return null;
	}

	escapeRate(id: string): number {
		const entry = this.getEntry(id);
		if (!entry || entry.usage === 0) return 0;
		return entry.escapes / entry.usage;
	}

	private writeEntity(entity: LibraryEntity, level: 1 | 2 | 3): void {
		const dir = join(this.rootDir, entityDir(level));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${entity.id}.json`), `${JSON.stringify(entity, null, "\t")}\n`);
	}

	save(): void {
		mkdirSync(this.rootDir, { recursive: true });
		writeFileSync(join(this.rootDir, "registry.json"), `${JSON.stringify({ entries: this.entries }, null, "\t")}\n`);
	}

	private saveCatalog(): void {
		mkdirSync(this.rootDir, { recursive: true });
		writeFileSync(join(this.rootDir, "catalog.json"), `${JSON.stringify(this.catalog, null, "\t")}\n`);
	}

	/** Scan entity files not present in the registry (repair helper). */
	detectOrphans(): string[] {
		const known = new Set(this.entries.map((e) => e.id));
		const orphans: string[] = [];
		for (const dir of ["atoms", "workflows", "orchestrations"] as const) {
			const dirPath = join(this.rootDir, dir);
			if (!existsSync(dirPath)) continue;
			for (const file of readdirSync(dirPath)) {
				const id = file.replace(/\.json$/, "");
				if (!known.has(id)) orphans.push(id);
			}
		}
		return orphans;
	}
}
