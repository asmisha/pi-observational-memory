import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { findLastCompactionIndex, realContextTokensAfterCompaction, type Entry } from "./session-ledger/index.js";

export interface ContextPressureCtx {
	cwd: string;
	model?: { provider?: unknown; id?: unknown };
	isProjectTrusted?: () => boolean;
	getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
}

export interface ContextPressure {
	/** Pi's estimate of the current context; null after a compaction until the next response. */
	tokens: number | null;
	/** Pi's automatic-compaction threshold for the session model: context window minus `reserveTokens`. */
	piThresholdTokens: number;
	/** Context size at which the idle trigger compacts: `compactAtPiThresholdRatio` of Pi's threshold. */
	triggerTokens: number;
	/**
	 * Context of the first response after the latest compaction, when that
	 * response already reached `triggerTokens`. Another compaction would likely
	 * leave the next run there too, so the idle trigger waits for Pi's threshold
	 * instead of compacting after every run.
	 */
	heldByPostCompactionTokens?: number;
	/** The idle trigger should compact now. */
	due: boolean;
}

/**
 * Pi's resolved compaction settings for the session model, read through Pi's
 * own settings manager so project trust and per-model overrides follow Pi's
 * precedence. Loaded once per runtime, like the extension's config, from the
 * settings files Pi's CLI reads (agent directory and project); the declared
 * extension API does not expose the session's own settings. A settings load
 * error leaves them unknown rather than falling back to Pi's built-in defaults.
 */
function piCompactionSettings(runtime: Runtime, ctx: ContextPressureCtx): { enabled: boolean; reserveTokens: number } | undefined {
	const model = ctx.model;
	if (typeof model?.provider !== "string" || typeof model.id !== "string") return undefined;
	if (!runtime.piSettings) {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() ?? true });
		if (settings.drainErrors().length > 0) return undefined;
		runtime.piSettings = settings;
	}
	return runtime.piSettings.getCompactionSettings({ provider: model.provider, id: model.id });
}

/**
 * Real context against Pi's automatic-compaction threshold. A run that starts
 * near that threshold is compacted part-way through, after its own request has
 * left the kept context; compacting while idle gives the next run room instead.
 * Undefined when Pi's automatic compaction is off or the threshold is unknown.
 */
export function contextPressure(runtime: Runtime, ctx: ContextPressureCtx, entries: Entry[]): ContextPressure | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage || !(usage.contextWindow > 0)) return undefined;
	const settings = piCompactionSettings(runtime, ctx);
	if (!settings?.enabled) return undefined;
	const piThresholdTokens = usage.contextWindow - settings.reserveTokens;
	if (piThresholdTokens <= 0) return undefined;

	const triggerTokens = Math.floor(piThresholdTokens * runtime.config.compactAtPiThresholdRatio);
	const compactionIndex = findLastCompactionIndex(entries);
	const postCompactionTokens = compactionIndex === -1 ? undefined : realContextTokensAfterCompaction(entries, compactionIndex);
	const heldByPostCompactionTokens = postCompactionTokens !== undefined && postCompactionTokens >= triggerTokens
		? postCompactionTokens
		: undefined;
	const due = usage.tokens !== null && usage.tokens >= triggerTokens && heldByPostCompactionTokens === undefined;
	return {
		tokens: usage.tokens,
		piThresholdTokens,
		triggerTokens,
		...(heldByPostCompactionTokens === undefined ? {} : { heldByPostCompactionTokens }),
		due,
	};
}
