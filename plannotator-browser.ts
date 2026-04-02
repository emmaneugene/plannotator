import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getGitContext,
	runGitDiff,
	startAnnotateServer,
	startPlanReviewServer,
	startReviewServer,
	type DiffType,
} from "./server.js";
import { openBrowser } from "./server/network.js";

export type AnnotateMode = "annotate" | "annotate-folder" | "annotate-last";
export interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
}

export interface PlanReviewBrowserSession {
	reviewId: string;
	url: string;
	waitForDecision: () => Promise<PlanReviewDecision>;
	onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
	stop: () => void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let planHtmlContent = "";
let reviewHtmlContent = "";

try {
	planHtmlContent = readFileSync(resolve(__dirname, "plannotator.html"), "utf-8");
} catch {
	// built assets unavailable
}

try {
	reviewHtmlContent = readFileSync(resolve(__dirname, "review-editor.html"), "utf-8");
} catch {
	// built assets unavailable
}

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function hasPlanBrowserHtml(): boolean {
	return Boolean(planHtmlContent);
}

export function hasReviewBrowserHtml(): boolean {
	return Boolean(reviewHtmlContent);
}

export function getStartupErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

type AssistantTextBlock = { type?: string; text?: string };

type AssistantMessageLike = { role?: unknown; content?: unknown };

function isAssistantMessage(message: AssistantMessageLike): message is { role: "assistant"; content: AssistantTextBlock[] } {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: { content: AssistantTextBlock[] }): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export async function getLastAssistantMessageText(ctx: ExtensionContext): Promise<string | null> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; message?: AssistantMessageLike };
		if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
			const text = getTextContent(entry.message);
			if (text.trim()) return text;
		}
	}
	return null;
}

function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): void {
	const browserResult = openBrowser(serverUrl);
	if (browserResult.isRemote) {
		ctx.ui.notify(`Remote session. Open manually: ${browserResult.url}`, "info");
	} else if (!browserResult.opened) {
		ctx.ui.notify(`Open this URL to review: ${serverUrl}`, "info");
	}
}

async function openBrowserAndWait<T>(
	server: { url: string; stop: () => void },
	ctx: ExtensionContext,
	waitForResult: () => Promise<T>,
): Promise<T> {
	openBrowserForServer(server.url, ctx);

	const result = await waitForResult();
	await delay(1500);
	server.stop();
	return result;
}

export async function startPlanReviewBrowserSession(
	ctx: ExtensionContext,
	planContent: string,
): Promise<PlanReviewBrowserSession> {
	if (!ctx.hasUI || !planHtmlContent) {
		throw new Error("Plannotator browser review is unavailable in this session.");
	}

	const server = await startPlanReviewServer({
		plan: planContent,
		htmlContent: planHtmlContent,
		origin: "pi",
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	});

	openBrowserForServer(server.url, ctx);
	server.onDecision(() => {
		setTimeout(() => server.stop(), 1500);
	});

	return {
		reviewId: server.reviewId,
		url: server.url,
		waitForDecision: server.waitForDecision,
		onDecision: server.onDecision,
		stop: server.stop,
	};
}

export async function openPlanReviewBrowser(
	ctx: ExtensionContext,
	planContent: string,
): Promise<PlanReviewDecision> {
	const session = await startPlanReviewBrowserSession(ctx, planContent);
	return session.waitForDecision();
}

export async function openCodeReview(
	ctx: ExtensionContext,
	options: { cwd?: string; defaultBranch?: string; diffType?: DiffType } = {},
): Promise<{ approved: boolean; feedback?: string; annotations?: unknown[]; agentSwitch?: string }> {
	if (!ctx.hasUI || !reviewHtmlContent) {
		throw new Error("Plannotator code review browser is unavailable in this session.");
	}

	const cwd = options.cwd ?? ctx.cwd;
	const gitCtx = await getGitContext(cwd);
	const defaultBranch = options.defaultBranch ?? gitCtx.defaultBranch;
	const diffType: DiffType = options.diffType ?? "uncommitted";
	const { patch: rawPatch, label: gitRef, error } = await runGitDiff(diffType, defaultBranch, cwd);
	const server = await startReviewServer({
		rawPatch,
		gitRef,
		error,
		origin: "pi",
		diffType,
		gitContext: gitCtx,
		htmlContent: reviewHtmlContent,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
	});

	return openBrowserAndWait(server, ctx, server.waitForDecision);
}

export async function openMarkdownAnnotation(
	ctx: ExtensionContext,
	filePath: string,
	markdown: string,
	mode: AnnotateMode,
	folderPath?: string,
): Promise<{ feedback: string }> {
	if (!ctx.hasUI || !planHtmlContent) {
		throw new Error("Plannotator annotation browser is unavailable in this session.");
	}

	let resolvedMarkdown = markdown;
	if (!resolvedMarkdown.trim() && existsSync(filePath)) {
		try {
			const fileStat = statSync(filePath);
			if (!fileStat.isDirectory()) {
				resolvedMarkdown = readFileSync(filePath, "utf-8");
			}
		} catch {
			// fall back to provided markdown
		}
	}

	const server = await startAnnotateServer({
		markdown: resolvedMarkdown,
		filePath,
		origin: "pi",
		mode,
		folderPath,
		htmlContent: planHtmlContent,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	});

	return openBrowserAndWait(server, ctx, server.waitForDecision);
}

export async function openLastMessageAnnotation(
	ctx: ExtensionContext,
	lastText: string,
): Promise<{ feedback: string }> {
	return openMarkdownAnnotation(ctx, "last-message", lastText, "annotate-last");
}

export async function openArchiveBrowserAction(
	ctx: ExtensionContext,
	customPlanPath?: string,
): Promise<{ opened: boolean }> {
	if (!ctx.hasUI || !planHtmlContent) {
		throw new Error("Plannotator archive browser is unavailable in this session.");
	}

	const server = await startPlanReviewServer({
		plan: "",
		htmlContent: planHtmlContent,
		origin: "pi",
		mode: "archive",
		customPlanPath,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	});

	return openBrowserAndWait(server, ctx, async () => {
		if (server.waitForDone) {
			await server.waitForDone();
		}
		return { opened: true };
	});
}
