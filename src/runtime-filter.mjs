// Extension exclusion matcher for the pi-watcher side agent.
//
// Plain JavaScript on purpose: it is imported by the child entry (`runtime-child.mjs`), which node
// runs directly, before pi (and its TypeScript loader) is available.
//
// A "resource" is what pi's DefaultPackageManager.resolve() returns for an extension:
//   { path: string, enabled: boolean, metadata: { source, scope, origin, baseDir?, packageRoot? } }

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";

const BUILTIN_PREFIX = "builtin:";

function expandHome(p) {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
	return p;
}

function safeRealpath(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** All comparable spellings of an absolute path (as given and realpath). */
function pathVariants(p) {
	const abs = resolve(p);
	const real = safeRealpath(abs);
	return real === abs ? [abs] : [abs, real];
}

function isInside(child, parent) {
	if (child === parent) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}

function pathMatchesRoot(candidate, roots) {
	if (!candidate) return false;
	const variants = pathVariants(candidate);
	return roots.some((root) => variants.some((v) => isInside(v, root)));
}

function isPathLike(entry) {
	// Scoped npm package name (@scope/name) is a name, not a path.
	if (/^@[^/\\]+\/[^/\\]+$/.test(entry)) return false;
	return (
		isAbsolute(entry) ||
		entry.startsWith(".") ||
		entry.startsWith("~") ||
		entry.includes("/") ||
		entry.includes("\\")
	);
}

const SOURCE_PREFIX_RE = /^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/i;

/** Normalise a package source string for comparison: strip version/ref, trailing .git and slashes. */
export function normalizeSource(source) {
	let s = String(source).trim();
	if (/^npm:/i.test(s)) {
		const spec = s.slice(4);
		// @scope/name@1.2.3 or name@1.2.3
		const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
		return `npm:${(at > 0 ? spec.slice(0, at) : spec).toLowerCase()}`;
	}
	s = s.replace(/^git:/i, "").replace(/^https?:\/\//i, "").replace(/^ssh:\/\//i, "");
	s = s.replace(/^git@([^:]+):/i, "$1/");
	// strip @ref (only after the last path segment)
	const lastSlash = s.lastIndexOf("/");
	const at = s.indexOf("@", lastSlash + 1);
	if (at > 0) s = s.slice(0, at);
	s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
	return `git:${s.toLowerCase()}`;
}

const packageNameCache = new Map();
function readPackageName(dir) {
	if (!dir) return undefined;
	if (packageNameCache.has(dir)) return packageNameCache.get(dir);
	let name;
	try {
		const file = resolve(dir, "package.json");
		if (existsSync(file)) name = JSON.parse(readFileSync(file, "utf8")).name;
	} catch {
		name = undefined;
	}
	packageNameCache.set(dir, typeof name === "string" ? name : undefined);
	return packageNameCache.get(dir);
}

/** Find the nearest directory (from `start` upward) containing package.json. */
export function findPackageRoot(start) {
	let dir = resolve(start);
	for (let i = 0; i < 64; i++) {
		if (existsSync(resolve(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

function extensionNames(resourcePath) {
	const names = new Set();
	const base = basename(resourcePath);
	const stem = base.slice(0, base.length - extname(base).length);
	names.add(base.toLowerCase());
	names.add(stem.toLowerCase());
	if (stem === "index") names.add(basename(dirname(resourcePath)).toLowerCase());
	return names;
}

/**
 * Compile an exclusion spec.
 * @param {{ cwd?: string, roots?: string[], entries?: string[], keep?: string[] }} spec
 */
export function compileExclusions(spec = {}) {
	const cwd = spec.cwd ? resolve(spec.cwd) : process.cwd();
	const roots = [];
	const builtins = new Set();
	const sources = new Set();
	const names = new Set();
	const keep = new Set();
	for (const k of spec.keep ?? []) if (k) for (const v of pathVariants(resolve(cwd, expandHome(k)))) keep.add(v);
	const addRoot = (p) => {
		for (const v of pathVariants(p)) if (!roots.includes(v)) roots.push(v);
	};
	for (const root of spec.roots ?? []) if (root) addRoot(resolve(cwd, expandHome(root)));
	for (const raw of spec.entries ?? []) {
		if (typeof raw !== "string") continue;
		const entry = raw.trim();
		if (!entry) continue;
		if (entry.toLowerCase().startsWith(BUILTIN_PREFIX)) {
			builtins.add(entry.toLowerCase());
		} else if (SOURCE_PREFIX_RE.test(entry)) {
			sources.add(normalizeSource(entry));
		} else if (isPathLike(entry)) {
			addRoot(resolve(cwd, expandHome(entry)));
		} else {
			names.add(entry.toLowerCase());
		}
	}
	return { cwd, roots, builtins, sources, names, keep };
}

/**
 * Decide whether an extension resource is excluded. Returns a reason string or undefined.
 * @param {{ path: string, metadata?: any }} resource
 * @param {ReturnType<typeof compileExclusions>} compiled
 */
export function matchExclusion(resource, compiled) {
	const path = resource?.path;
	if (typeof path !== "string" || !path) return undefined;
	const meta = resource.metadata ?? {};
	if (path.toLowerCase().startsWith(BUILTIN_PREFIX)) {
		return compiled.builtins.has(path.toLowerCase()) ? `builtin ${path}` : undefined;
	}
	const absPath = resolve(compiled.cwd, expandHome(path));
	if (compiled.keep?.size && pathVariants(absPath).some((v) => compiled.keep.has(v))) return undefined;
	if (pathMatchesRoot(absPath, compiled.roots)) return `path ${absPath}`;
	if (meta.packageRoot && pathMatchesRoot(meta.packageRoot, compiled.roots)) return `package root ${meta.packageRoot}`;
	if (typeof meta.source === "string" && compiled.sources.size > 0 && SOURCE_PREFIX_RE.test(meta.source)) {
		if (compiled.sources.has(normalizeSource(meta.source))) return `source ${meta.source}`;
	}
	if (compiled.names.size > 0) {
		const pkgDir = meta.packageRoot ?? findPackageRoot(dirname(absPath));
		const pkgName = readPackageName(pkgDir);
		if (pkgName && compiled.names.has(pkgName.toLowerCase())) return `package ${pkgName}`;
		if (typeof meta.source === "string" && /^npm:/i.test(meta.source)) {
			const npmName = normalizeSource(meta.source).slice(4);
			if (compiled.names.has(npmName)) return `package ${npmName}`;
		}
		for (const n of extensionNames(absPath)) if (compiled.names.has(n)) return `name ${n}`;
	}
	return undefined;
}

/**
 * Return a copy of ResolvedPaths with excluded extensions disabled.
 * @returns {{ result: any, excluded: Array<{ path: string, reason: string }> }}
 */
export function applyExclusions(resolvedPaths, compiled) {
	const excluded = [];
	if (!resolvedPaths || !Array.isArray(resolvedPaths.extensions)) return { result: resolvedPaths, excluded };
	const extensions = resolvedPaths.extensions.map((resource) => {
		if (!resource || !resource.enabled) return resource;
		const reason = matchExclusion(resource, compiled);
		if (!reason) return resource;
		excluded.push({ path: resource.path, reason });
		return { ...resource, enabled: false };
	});
	return { result: { ...resolvedPaths, extensions }, excluded };
}
