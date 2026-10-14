import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function captureHandler(args: { compactAfterTokens?: number; compactAfterTokensMode?: "calibrated" | "ratio"; compactAfterTokensRatio?: number; compactAtPiThresholdRatio?: number; passive?: boolean; compactInFlight?: boolean; piAutoCompactionEnabled?: boolean } = {}) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			expect(name).toBe("agent_settled");
			handler = cb;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			compactAfterTokens: args.compactAfterTokens ?? 3,
			compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
			compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
			compactAtPiThresholdRatio: args.compactAtPiThresholdRatio ?? 0.7,
			passive: args.passive ?? false,
			piAutoCompactionEnabled: args.piAutoCompactionEnabled ?? true,
		},
		compactInFlight: args.compactInFlight ?? false,
		observerPromise: new Promise(() => {}),
		reflectDropPromise: new Promise(() => {}),
	};
	registerCompactionTrigger(pi as any, runtime as any);
	if (!handler) throw new Error("agent_settled handler was not registered");
	return { handler, runtime };
}

function agentSettled() {
	return { type: "agent_settled" };
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: { getBranch },
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		model: undefined,
		...overrides,
	};
}

const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);

/** Append an observation coverage marker so the whole branch counts as observed. */
function covered(branch: TestEntry[], coversUpToId?: string): TestEntry[] {
	const target = coversUpToId ?? [...branch].reverse().find((entry) => SOURCE_TYPES.has(entry.type))?.id;
	if (!target) throw new Error("branch has no source entry to cover");
	return [
		...branch,
		observationsRecordedEntry(`om-cov-${target}`, { observations: [observation("aaaaaaaaaaaa")], coversUpToId: target }),
	];
}

const dueBranch = covered([textCustomMessage("raw-1", "aaaaaaaaaaaa")]); // 3 tokens, observed
const belowBranch = covered([textCustomMessage("raw-1", "aaaa")]); // 1 token, observed

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 observed source tokens); triggering compaction",
			"info",
		);
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		]);
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("does not compact when provider context and anchored growth exceed the threshold but raw progress does not", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 130000 });
		const branch = covered([
			compactionEntry("cmp-1", { firstKeptEntryId: "baseline" }),
			rawMessage("baseline", "baseline", {
				message: {
					role: "assistant",
					content: "baseline",
					stopReason: "end_turn",
					usage: { totalTokens: 5000 },
				},
			}),
			textCustomMessage("raw-1", "a".repeat(302_248)), // 75,562 tokens plus the 2-token baseline message
		]);
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 135636, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("uses raw progress when provider growth is lower than the raw threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		]);
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress from the first kept entry through the current branch", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([
			textCustomMessage("old", "bbbbbbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "kept" }),
			textCustomMessage("kept", "aaaaaaaa"),
			textCustomMessage("new", "bbbbbbbbbbbb"),
		]);
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress from the branch start before the first compaction", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses the same raw metric after deferred re-check", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(runtime.compactInFlight).toBe(true);
	});

	it("ignores high provider context before the first compaction", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 130000 });
		const ctx = fakeCtx([dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 130000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("compacts when raw progress equals the threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		]);
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress when provider usage is unknown or has no baseline", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([compactionEntry("cmp-1"), textCustomMessage("raw-1", "aaaa")]);
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: null, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("rechecks raw progress after deferral", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("falls back to raw progress after a model change", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([
			compactionEntry("cmp-1"),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 60000 } },
			}),
			{ type: "model_change", id: "model-1", timestamp: "2026-05-02T10:00:00.000Z" },
			textCustomMessage("raw-1", "aaaa"),
		]);
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 190000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not compact when observation coverage has not reached the threshold", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		// 4 raw tokens in total, but only the first entry (1 token) is observed.
		const branch = covered([
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "aaaaaaaaaaaa"),
		], "raw-1");
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("does not compact without any observation coverage", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([[textCustomMessage("raw-1", "aaaaaaaaaaaa")]]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("ignores observation coverage that precedes the latest compaction boundary", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-0", "aaaaaaaaaaaa"),
			observationsRecordedEntry("om-cov-raw-0", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-0" }),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("compacts once coverage catches up with the retained tail", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = covered([
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "aaaaaaaaaaaa"),
		]);
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("counts raw tokens when Pi's own auto-compaction is disabled (PR #81 review, issue 4)", async () => {
		// No observation coverage at all: with Pi's auto-compaction off nothing
		// else would compact, so the raw metric applies.
		const { handler } = captureHandler({ compactAfterTokens: 3, piAutoCompactionEnabled: false });
		const ctx = fakeCtx([[textCustomMessage("raw-1", "aaaaaaaaaaaa")]]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 estimated source tokens); triggering compaction",
			"info",
		);
	});

	describe("ratio mode", () => {
		it("scales the compaction threshold by model.contextWindow", async () => {
			// 3 tokens raw; ratio 0.5 of 4-token window = 2 -> threshold 2, so 3 >= 2 fires.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact when raw tokens are below the scaled threshold", async () => {
			// 1 token raw (belowBranch); ratio 0.5 of 4 = 2 -> threshold 2, so 1 < 2 does not fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([belowBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the model context window in ratio mode", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], {
				model: { contextWindow: 4 },
				getContextUsage: vi.fn(() => ({ tokens: 2, contextWindow: 10 })),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when contextWindow is zero", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 0 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the same resolved threshold on deferred re-check", async () => {
			// threshold = 0.5 * 4 = 2; first branch has 3 (fires, deferred), isIdle=false defers,
			// second branch has 1 (< 2) -> skipped because another compaction reduced pressure.
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch, belowBranch], {
				model: { contextWindow: 4 },
				isIdle: vi.fn(() => false),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});

	describe("context pressure", () => {
		// Pi's threshold for this model is 372,000 - 72,000 = 300,000 (the per-model
		// override, not the general 147,000 reserve), so 70% of it is 210,000.
		const model = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 372_000 };
		let root: string;
		let cwd: string;
		let agentDir: string;
		let previousAgentDir: string | undefined;

		beforeEach(() => {
			root = join(tmpdir(), `om-context-pressure-${process.pid}-${Math.random().toString(16).slice(2)}`);
			cwd = join(root, "project");
			agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
				compaction: {
					reserveTokens: 147_000,
					modelOverrides: { "anthropic/claude-opus-5-5": { reserveTokens: 72_000 } },
				},
			}));
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir;
		});

		afterEach(() => {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		});

		function pressureCtx(branches: TestEntry[][], tokens: (number | null)[]) {
			let usageIndex = 0;
			return fakeCtx(branches, {
				cwd,
				model,
				isProjectTrusted: () => true,
				getContextUsage: vi.fn(() => ({
					tokens: tokens[Math.min(usageIndex++, tokens.length - 1)],
					contextWindow: model.contextWindow,
				})),
			});
		}

		function assistantWithContext(id: string, totalTokens: number): TestEntry {
			return rawMessage(id, "done", {
				message: { role: "assistant", content: "done", stopReason: "stop", usage: { totalTokens } },
			});
		}

		it("compacts an idle session at 70% of Pi's per-model threshold before the observed threshold", async () => {
			const { handler } = captureHandler({ compactAfterTokens: 81_000 });
			const ctx = pressureCtx([belowBranch], [210_000]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"Observational memory: context reached ~210,000 tokens, 70% of Pi's 300,000-token compaction threshold; triggering compaction",
				"info",
			);
		});

		it("does not compact below 70% of Pi's per-model threshold", async () => {
			const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
			const ctx = pressureCtx([belowBranch], [209_999]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});

		it("uses compactAtPiThresholdRatio", async () => {
			const { handler } = captureHandler({ compactAfterTokens: 81_000, compactAtPiThresholdRatio: 0.5 });
			const ctx = pressureCtx([belowBranch], [150_000]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact by context when Pi's automatic compaction is disabled", async () => {
			const { handler } = captureHandler({ compactAfterTokens: 81_000, piAutoCompactionEnabled: false });
			const ctx = pressureCtx([belowBranch], [290_000]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("does not guess Pi's threshold when its settings fail to load", async () => {
			writeFileSync(join(agentDir, "settings.json"), "{ not json");
			const { handler } = captureHandler({ compactAfterTokens: 81_000 });
			const ctx = pressureCtx([belowBranch], [290_000]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("waits for the next response after a compaction, then compacts only once context reaches the trigger again", async () => {
			const { handler } = captureHandler({ compactAfterTokens: 81_000 });
			const justCompacted = [compactionEntry("cmp-1", { firstKeptEntryId: "kept" }), textCustomMessage("kept", "aaaa")];
			const afterOneTurn = [...justCompacted, assistantWithContext("a-1", 65_000)];

			// Pi reports no context size until a response follows the compaction.
			const first = pressureCtx([justCompacted], [null]);
			handler(agentSettled(), first);
			await vi.runAllTimersAsync();
			expect(first.compact).not.toHaveBeenCalled();

			const second = pressureCtx([afterOneTurn], [65_000]);
			handler(agentSettled(), second);
			await vi.runAllTimersAsync();
			expect(second.compact).not.toHaveBeenCalled();

			const grown = [...afterOneTurn, assistantWithContext("a-2", 212_000)];
			const third = pressureCtx([grown], [212_000]);
			handler(agentSettled(), third);
			await vi.runAllTimersAsync();
			expect(third.compact).toHaveBeenCalledTimes(1);
		});

		it("leaves compaction to Pi when the latest compaction already left context at the trigger", async () => {
			const { handler } = captureHandler({ compactAfterTokens: 81_000 });
			const branch = [
				compactionEntry("cmp-1", { firstKeptEntryId: "kept" }),
				textCustomMessage("kept", "aaaa"),
				assistantWithContext("a-1", 215_000),
				assistantWithContext("a-2", 240_000),
			];
			const ctx = pressureCtx([branch], [240_000]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("re-checks context before deferred compaction", async () => {
			const { handler, runtime } = captureHandler({ compactAfterTokens: 81_000 });
			// Another compaction finished before the deferred check ran.
			const ctx = pressureCtx([belowBranch], [230_000, null]);

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
				"info",
			);
		});
	});
});
