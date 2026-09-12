import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { logUsage } from "../debug-log.js";

/** Observe completed model calls without changing memory-agent execution. */
export function createUsageTracker(stage: "observer" | "reflector" | "dropper"): (event: AgentEvent) => void {
	let startedAt: number | undefined;
	return (event) => {
		if (event.type === "turn_start") {
			startedAt = performance.now();
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			startedAt ??= performance.now();
			return;
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const message = event.message;
		const usage = message.usage as (typeof message.usage & { reasoning?: number }) | undefined;
		logUsage({
			stage,
			provider: message.provider,
			model: message.model,
			stopReason: message.stopReason,
			elapsedMs: startedAt === undefined ? null : Math.round(performance.now() - startedAt),
			usage: usage ? {
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				output: usage.output,
				reasoning: usage.reasoning,
				totalTokens: usage.totalTokens,
				estimatedCost: usage.cost?.total,
			} : null,
		});
		startedAt = undefined;
	};
}
