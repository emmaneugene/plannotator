/**
 * Document and reference handlers (Node.js equivalents of packages/server/reference-handlers.ts).
 * VaultNode, buildFileTree, walkMarkdownFiles, handleDocRequest,
 * detectObsidianVaults, handleObsidian*, handleFileBrowserRequest
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	type Dirent,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { join, resolve as resolvePath } from "node:path";

import { json } from "./helpers";

import {
	type VaultNode,
	buildFileTree,
	FILE_BROWSER_EXCLUDED,
} from "../generated/reference-common.js";
import { detectObsidianVaults } from "../generated/integrations-common.js";
import { resolveMarkdownFile } from "../generated/resolve-file.js";

type Res = ServerResponse;

/** Recursively walk a directory collecting markdown files, skipping ignored dirs. */
function walkMarkdownFiles(dir: string, root: string, results: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (FILE_BROWSER_EXCLUDED.includes(entry.name + "/")) continue;
			walkMarkdownFiles(join(dir, entry.name), root, results);
		} else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
			const relative = join(dir, entry.name)
				.slice(root.length + 1)
				.replace(/\\/g, "/");
			results.push(relative);
		}
	}
}

/** Serve a linked markdown document. Uses shared resolveMarkdownFile for parity with Bun server. */
export function handleDocRequest(res: Res, url: URL): void {
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) {
		json(res, { error: "Missing path parameter" }, 400);
		return;
	}

	// Try resolving relative to base directory first (used by annotate mode)
	const base = url.searchParams.get("base");
	if (
		base &&
		!requestedPath.startsWith("/") &&
		/\.mdx?$/i.test(requestedPath)
	) {
		const fromBase = resolvePath(base, requestedPath);
		try {
			if (existsSync(fromBase)) {
				const markdown = readFileSync(fromBase, "utf-8");
				json(res, { markdown, filepath: fromBase });
				return;
			}
		} catch {
			/* fall through to standard resolution */
		}
	}

	const projectRoot = process.cwd();
	const result = resolveMarkdownFile(requestedPath, projectRoot);

	if (result.kind === "ambiguous") {
		json(
			res,
			{
				error: `Ambiguous filename '${result.input}': found ${result.matches.length} matches`,
				matches: result.matches,
			},
			400,
		);
		return;
	}

	if (result.kind === "not_found") {
		json(res, { error: `File not found: ${result.input}` }, 404);
		return;
	}

	try {
		const markdown = readFileSync(result.path, "utf-8");
		json(res, { markdown, filepath: result.path });
	} catch {
		json(res, { error: "Failed to read file" }, 500);
	}
}

export function handleObsidianVaultsRequest(res: Res): void {
	json(res, { vaults: detectObsidianVaults() });
}

export function handleObsidianFilesRequest(res: Res, url: URL): void {
	const vaultPath = url.searchParams.get("vaultPath");
	if (!vaultPath) {
		json(res, { error: "Missing vaultPath parameter" }, 400);
		return;
	}
	const resolvedVault = resolvePath(vaultPath);
	if (!existsSync(resolvedVault) || !statSync(resolvedVault).isDirectory()) {
		json(res, { error: "Invalid vault path" }, 400);
		return;
	}
	try {
		const files: string[] = [];
		walkMarkdownFiles(resolvedVault, resolvedVault, files);
		files.sort();
		json(res, { tree: buildFileTree(files) });
	} catch {
		json(res, { error: "Failed to list vault files" }, 500);
	}
}

export function handleObsidianDocRequest(res: Res, url: URL): void {
	const vaultPath = url.searchParams.get("vaultPath");
	const filePath = url.searchParams.get("path");
	if (!vaultPath || !filePath) {
		json(res, { error: "Missing vaultPath or path parameter" }, 400);
		return;
	}
	if (!/\.mdx?$/i.test(filePath)) {
		json(res, { error: "Only markdown files are supported" }, 400);
		return;
	}
	const resolvedVault = resolvePath(vaultPath);
	let resolvedFile = resolvePath(resolvedVault, filePath);

	// Bare filename search within vault
	if (!existsSync(resolvedFile) && !filePath.includes("/")) {
		const files: string[] = [];
		walkMarkdownFiles(resolvedVault, resolvedVault, files);
		const matches = files.filter(
			(f) => f.split("/").pop()!.toLowerCase() === filePath.toLowerCase(),
		);
		if (matches.length === 1) {
			resolvedFile = resolvePath(resolvedVault, matches[0]);
		} else if (matches.length > 1) {
			json(
				res,
				{
					error: `Ambiguous filename '${filePath}': found ${matches.length} matches`,
					matches,
				},
				400,
			);
			return;
		}
	}

	// Security: must be within vault
	if (
		!resolvedFile.startsWith(resolvedVault + "/") &&
		resolvedFile !== resolvedVault
	) {
		json(res, { error: "Access denied: path is outside vault" }, 403);
		return;
	}

	if (!existsSync(resolvedFile)) {
		json(res, { error: `File not found: ${filePath}` }, 404);
		return;
	}
	try {
		const markdown = readFileSync(resolvedFile, "utf-8");
		json(res, { markdown, filepath: resolvedFile });
	} catch {
		json(res, { error: "Failed to read file" }, 500);
	}
}

export function handleFileBrowserRequest(res: Res, url: URL): void {
	const dirPath = url.searchParams.get("dirPath");
	if (!dirPath) {
		json(res, { error: "Missing dirPath parameter" }, 400);
		return;
	}
	const resolvedDir = resolvePath(dirPath);
	if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
		json(res, { error: "Invalid directory path" }, 400);
		return;
	}
	try {
		const files: string[] = [];
		walkMarkdownFiles(resolvedDir, resolvedDir, files);
		files.sort();
		json(res, { tree: buildFileTree(files) });
	} catch {
		json(res, { error: "Failed to list directory files" }, 500);
	}
}
