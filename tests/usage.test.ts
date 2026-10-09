import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => mock.agentDir }));

import { withDebugLogContext } from "../src/debug-log.js";
import { runObserver, ObserverStreamError } from "../src/agents/observer/agent.js";
import { runReflector } from "../src/agents/reflector/agent.js";
import { runDropper } from "../src/agents/dropper/agent.js";
import { runRetirer } from "../src/agents/retirer/agent.js";
import { createUsageTracker } from "../src/agents/usage.js";
import { observation, reflection } from "./fixtures/session.js";

const context = { enabled: false, sessionId: "session-a", sessionFile: "/private/session.jsonl", cwd: "/project", runId: "consolidation-a" };
function message(stopReason = "stop"): any {
	return { role: "assistant", provider: "synthetic", model: "synthetic-model", stopReason,
		content: [{ type: "text", text: "SECRET_CONTENT" }, { type: "thinking", thinking: "SECRET_REASONING" }],
		errorMessage: "SECRET_PROVIDER_ERROR", usage: { input: 100, cacheRead: 200, cacheWrite: 3, output: 40, reasoning: 25, totalTokens: 343, cost: { total: 0.01 } } };
}
function loopFor(messages: any[]): any {
	return () => ({
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				yield { type: "message_start", message };
				yield { type: "message_end", message };
				yield { type: "turn_end", message, toolResults: [] };
			}
		},
		result: async () => [],
	});
}
const base = { model: {} as any, apiKey: "SECRET_KEY" };
const stages = {
	observer: (agentLoop: any) => runObserver({ ...base, priorReflections: [], priorObservations: [], chunk: "SECRET_PROMPT", allowedSourceEntryIds: ["source-a"], agentLoop }),
	reflector: (agentLoop: any) => runReflector({ ...base, reflections: [], observations: [observation("aaaaaaaaaaaa")], agentLoop }),
	dropper: (agentLoop: any) => runDropper({ ...base, reflections: [], observations: [observation("aaaaaaaaaaaa", { tokenCount: 10 }), observation("bbbbbbbbbbbb", { tokenCount: 10 })], targetTokens: 1, agentLoop }),
	retirer: (agentLoop: any) => runRetirer({ ...base, reflections: [reflection("rrrrrrrrrrr1"), reflection("rrrrrrrrrrr2")], agentLoop }),
};
function logPath(): string { return join(mock.agentDir, "observational-memory", "usage", "session-a.ndjson"); }
function rows(): any[] { return readFileSync(logPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line)); }

beforeEach(() => { mock.agentDir = mkdtempSync(join(tmpdir(), "om-usage-test-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(mock.agentDir, { recursive: true, force: true }); });

describe("memory model usage", () => {
	it.each(Object.entries(stages))("records each completed %s model call once even with debug disabled", async (stage, run) => {
		await withDebugLogContext(context, () => run(loopFor([message("toolUse"), message()])));
		const records = rows();
		expect(records).toHaveLength(2);
		expect(new Set(records.map((r) => r.callId)).size).toBe(2);
		for (const record of records) {
			expect(record).toMatchObject({ sessionId: context.sessionId, sessionFile: context.sessionFile, runId: context.runId, cwd: context.cwd, stage,
				provider: "synthetic", model: "synthetic-model", usage: { input: 100, cacheRead: 200, cacheWrite: 3, output: 40, reasoning: 25, totalTokens: 343, estimatedCost: 0.01 } });
			expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
		}
		expect(records.reduce((sum, r) => sum + r.usage.totalTokens, 0)).toBe(686);
		expect(readFileSync(logPath(), "utf8")).not.toContain("SECRET_");
		expect(existsSync(join(mock.agentDir, "observational-memory", "debug"))).toBe(false);
		if (process.platform !== "win32") expect(statSync(logPath()).mode & 0o777).toBe(0o600);
	});

	it.each(["error", "aborted"])("records %s usage without swallowing the observer failure", async (reason) => {
		await expect(withDebugLogContext(context, () => stages.observer(loopFor([message(reason)])))).rejects.toBeInstanceOf(ObserverStreamError);
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ stopReason: reason, usage: { totalTokens: 343 } });
	});

	it("keeps missing usage and timing distinguishable from zero", () => {
		withDebugLogContext(context, () => createUsageTracker("observer")({ type: "message_end", message: { ...message(), usage: undefined } } as any));
		expect(rows()[0]).toMatchObject({ usage: null, elapsedMs: null });
	});

	it("measures each response interval and ignores non-assistant events", () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(35).mockReturnValueOnce(50).mockReturnValueOnce(90);
		withDebugLogContext(context, () => {
			const track = createUsageTracker("observer");
			track({ type: "message_end", message: { role: "user", content: "SECRET_USER" } } as any);
			for (let i = 0; i < 2; i++) { track({ type: "message_start", message: message() } as any); track({ type: "message_end", message: message() } as any); }
		});
		expect(rows().map((r) => r.elapsedMs)).toEqual([25, 40]);
	});

	it("includes time before the first response message when turn_start is available", () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(70);
		withDebugLogContext(context, () => {
			const track = createUsageTracker("observer");
			track({ type: "turn_start" } as any);
			track({ type: "message_start", message: message() } as any);
			track({ type: "message_end", message: message() } as any);
		});
		expect(rows()[0].elapsedMs).toBe(60);
	});

	it("does not interrupt a memory agent when the log destination is unwritable", async () => {
		writeFileSync(join(mock.agentDir, "observational-memory"), "not a directory");
		await expect(withDebugLogContext(context, () => stages.observer(loopFor([message()])))).resolves.toBeUndefined();
	});

	it("rotates a full session log and retains the previous usage records", async () => {
		await withDebugLogContext(context, () => stages.observer(loopFor([message()])));
		const previous = readFileSync(logPath(), "utf8") + " ".repeat(10 * 1024 * 1024);
		writeFileSync(logPath(), previous);
		await withDebugLogContext(context, () => stages.observer(loopFor([message()])));
		expect(readFileSync(`${logPath()}.1`, "utf8")).toBe(previous);
		expect(rows()).toHaveLength(1);
	});
});
