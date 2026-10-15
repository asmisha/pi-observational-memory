import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { maybeTriggerCompaction, registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";

/** Session-local flag that pi-dynamic-workflows sets on its subagent sessions before binding extensions. */
const WORKFLOW_SUBAGENT_FLAG = "pi-dynamic-workflows-subagent";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	pi.registerFlag(WORKFLOW_SUBAGENT_FLAG, {
		description: "Session is managed by pi-dynamic-workflows",
		type: "boolean",
		default: false,
	});
	// The flag value is not available while this factory runs; read it at session start.
	pi.on("session_start", () => {
		runtime.workflowSubagent = pi.getFlag(WORKFLOW_SUBAGENT_FLAG) === true;
	});

	registerConsolidationTrigger(pi, runtime, {
		afterIdleConsolidation: (ctx) => maybeTriggerCompaction(runtime, ctx as Parameters<typeof maybeTriggerCompaction>[1]),
	});
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerRecallTool(pi);
}
