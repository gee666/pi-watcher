export interface ExclusionSpec {
	cwd?: string;
	/** Directories (or files) whose extensions are always excluded, e.g. the pi-watcher package root. */
	roots?: string[];
	/** User entries: paths, `npm:`/`git:`/URL sources, `builtin:<name>`, or bare package/extension names. */
	entries?: string[];
	/** Exact extension paths that are never excluded (the side-agent bridge extension). */
	keep?: string[];
}

export interface CompiledExclusions {
	cwd: string;
	roots: string[];
	builtins: Set<string>;
	sources: Set<string>;
	names: Set<string>;
	keep: Set<string>;
}

export interface ExtensionResourceLike {
	path: string;
	enabled?: boolean;
	metadata?: { source?: string; scope?: string; origin?: string; baseDir?: string; packageRoot?: string };
}

export interface ExcludedExtension {
	path: string;
	reason: string;
}

export function normalizeSource(source: string): string;
export function findPackageRoot(start: string): string | undefined;
export function compileExclusions(spec?: ExclusionSpec): CompiledExclusions;
export function matchExclusion(resource: ExtensionResourceLike, compiled: CompiledExclusions): string | undefined;
export function applyExclusions<T extends { extensions?: ExtensionResourceLike[] }>(
	resolvedPaths: T,
	compiled: CompiledExclusions,
): { result: T; excluded: ExcludedExtension[] };
