import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { logAgentStreamError } from "../stream-errors.js";
import { createUsageTracker } from "../usage.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { reflectionToSummaryLine, type Reflection } from "../../session-ledger/index.js";
import { RETIRER_SYSTEM } from "./prompts.js";

export class RetirerStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`retirer stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "RetirerStreamError";
		this.stopReason = stopReason;
	}
}

interface RunRetirerArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reflections: Reflection[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

const RetireReflectionsSchema = Type.Object({
	retirements: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			reason: Type.Union([Type.Literal("duplicate"), Type.Literal("superseded")]),
			keptBy: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type RetireReflectionsArgs = Static<typeof RetireReflectionsSchema>;

type Retirement = RetireReflectionsArgs["retirements"][number];

type RejectionReason = "unknown_id" | "already_retired" | "kept_by_another" | "invalid_kept_by";

/**
 * Accepts retirements one at a time, in proposal order. A retirement is valid
 * only when every reflection it relies on stays active: its keptBy ids must be
 * active, not itself, and not retired, and a reflection that an accepted
 * retirement relies on can no longer be retired. This keeps every retired
 * meaning covered by a reflection the assistant still sees.
 */
export class RetirementSelection {
	private readonly activeIds: Set<string>;
	private readonly retired = new Set<string>();
	private readonly keepers = new Set<string>();

	constructor(reflections: readonly Reflection[]) {
		this.activeIds = new Set(reflections.map((reflection) => reflection.id));
	}

	propose(retirement: Retirement): RejectionReason | undefined {
		const { id, keptBy } = retirement;
		if (!this.activeIds.has(id)) return "unknown_id";
		if (this.retired.has(id)) return "already_retired";
		if (this.keepers.has(id)) return "kept_by_another";
		const keepers = new Set(keptBy);
		for (const keeperId of keepers) {
			if (keeperId === id || !this.activeIds.has(keeperId) || this.retired.has(keeperId)) return "invalid_kept_by";
		}
		this.retired.add(id);
		for (const keeperId of keepers) this.keepers.add(keeperId);
		return undefined;
	}

	retiredIds(): string[] {
		return Array.from(this.retired);
	}
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export async function runRetirer(args: RunRetirerArgs): Promise<string[] | undefined> {
	const { model, apiKey, headers, env, reflections, signal } = args;
	if (reflections.length < 2) return undefined;

	debugLog("retirer.agent_start", { reflectionCount: reflections.length });
	const selection = new RetirementSelection(reflections);
	let toolCallCount = 0;
	let proposedCount = 0;
	const acceptedByReason: Record<Retirement["reason"], number> = { duplicate: 0, superseded: 0 };
	const rejectedByReason: Record<RejectionReason, number> = {
		unknown_id: 0,
		already_retired: 0,
		kept_by_another: 0,
		invalid_kept_by: 0,
	};

	const retireReflections: AgentTool<typeof RetireReflectionsSchema> = {
		name: "retire_reflections",
		label: "Retire reflections",
		description: "Retire duplicate or superseded reflections, naming the kept reflections that cover each one.",
		parameters: RetireReflectionsSchema,
		execute: async (_id, params: RetireReflectionsArgs) => {
			toolCallCount++;
			proposedCount += params.retirements.length;
			let accepted = 0;
			const rejected: string[] = [];
			for (const retirement of params.retirements) {
				const rejection = selection.propose(retirement);
				if (rejection) {
					rejectedByReason[rejection]++;
					rejected.push(`${retirement.id} (${rejection})`);
					continue;
				}
				acceptedByReason[retirement.reason]++;
				accepted++;
			}
			const rejectedText = rejected.length > 0 ? ` Rejected: ${rejected.join(", ")}.` : "";
			return {
				content: [{ type: "text", text: `Retired ${accepted} reflection${accepted === 1 ? "" : "s"}.${rejectedText}` }],
				details: { accepted, rejected: rejected.length },
			};
		},
	};

	const userText = `ACTIVE REFLECTIONS (oldest first):\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nRetire the reflections that kept ones make duplicate or superseded. If none qualify, do not call the tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = {
		messages: [{ role: "system", content: RETIRER_SYSTEM, timestamp: Date.now() }],
		tools: [retireReflections as AgentTool<any>],
	};
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				finishTurn: (turn) => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
					return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
	);
	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	const trackUsage = createUsageTracker("retirer");
	for await (const event of stream) {
		trackUsage(event);
		logAgentStreamError("retirer", event);
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();
	const retiredIds = selection.retiredIds();
	if (retiredIds.length === 0 && streamError) throw new RetirerStreamError(streamError.stopReason, streamError.errorMessage);
	debugLog("retirer.result", {
		toolCallCount,
		proposedCount,
		retiredCount: retiredIds.length,
		acceptedByReason,
		rejectedByReason,
	});
	return retiredIds.length > 0 ? retiredIds : undefined;
}
