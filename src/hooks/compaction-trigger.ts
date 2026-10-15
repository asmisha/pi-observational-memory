import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { contextPressure } from "../context-pressure.js";
import { observedTokensSinceLastCompaction, rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

/**
 * Source tokens counted toward the proactive threshold. Normally only tokens
 * the observer has covered: compacting past the frontier would discard entries
 * no memory describes, and Pi's own threshold compaction backstops a stalled
 * observer. When Pi's automatic compaction is disabled there is no backstop,
 * so count raw tokens; the compaction hook still protects unobserved entries
 * (catch-up, retention, or delegation to Pi's native summarizer).
 */
export function compactionProgress(runtime: Runtime, entries: Entry[]): number {
	return runtime.config.piAutoCompactionEnabled === false
		? rawTokensSinceLastCompaction(entries)
		: observedTokensSinceLastCompaction(entries);
}

export function progressLabel(runtime: Runtime): "observed" | "estimated" {
	return runtime.config.piAutoCompactionEnabled === false ? "estimated" : "observed";
}

type CompactionTriggerCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => maybeTriggerCompaction(runtime, ctx));
}

/**
 * Why the session should compact now, or undefined. Either the observed-source
 * threshold is reached, or real context passed `compactAtPiThresholdRatio` of
 * Pi's own compaction threshold.
 */
function compactionDueReason(runtime: Runtime, ctx: CompactionTriggerCtx, entries: Entry[], threshold: number): string | undefined {
	const progress = compactionProgress(runtime, entries);
	if (progress >= threshold) {
		return `compaction threshold reached (~${progress.toLocaleString()} ${progressLabel(runtime)} source tokens)`;
	}
	const pressure = contextPressure(runtime, ctx, entries);
	if (pressure?.due && pressure.tokens !== null) {
		const percent = Math.round(runtime.config.compactAtPiThresholdRatio * 100);
		return `context reached ~${pressure.tokens.toLocaleString()} tokens, ${percent}% of Pi's ${pressure.piThresholdTokens.toLocaleString()}-token compaction threshold`;
	}
	return undefined;
}

/**
 * Trigger proactive compaction when Pi is idle and either the observed-source
 * threshold or the context-pressure threshold is reached. Also called after an
 * idle-mode consolidation run finishes, so compaction is not starved by memory
 * work that ran on the same settled event.
 */
export function maybeTriggerCompaction(runtime: Runtime, ctx: CompactionTriggerCtx): void {
	{
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true || runtime.workflowSubagent) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		const reason = compactionDueReason(runtime, ctx, entries, threshold);
		if (reason === undefined) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) ui?.notify(`Observational memory: ${reason}; triggering compaction`, "info");

		runtime.compactInFlight = true;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					runtime.compactInFlight = false;
					return;
				}
				if (compactionDueReason(runtime, ctx, currentEntries, threshold) === undefined) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	}
}
