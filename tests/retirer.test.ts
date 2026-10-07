import { describe, expect, it } from "vitest";

import { RetirementSelection, RetirerStreamError, runRetirer } from "../src/agents/retirer/agent.js";
import { reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void, events: any[] = []): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

const refA = reflection("aaaaaaaaaaaa", ["obs-1"], { content: "Ticket X is blocked on review", recordedAt: "2026-05-01T10:00:00.000Z" });
const refB = reflection("bbbbbbbbbbbb", ["obs-2"], { content: "Ticket X merged after review", recordedAt: "2026-05-02T10:00:00.000Z" });
const refC = reflection("cccccccccccc", ["obs-3"], { content: "User prefers small PRs" });

describe("RetirementSelection", () => {
	it("accepts a retirement whose kept reflections are active and stay active", () => {
		const selection = new RetirementSelection([refA, refB, refC]);

		expect(selection.propose({ id: "aaaaaaaaaaaa", reason: "superseded", keptBy: ["bbbbbbbbbbbb"] })).toBeUndefined();
		expect(selection.retiredIds()).toEqual(["aaaaaaaaaaaa"]);
	});

	it("rejects unknown ids, self-coverage, and kept reflections that are not active", () => {
		const selection = new RetirementSelection([refA, refB, refC]);

		expect(selection.propose({ id: "dddddddddddd", reason: "duplicate", keptBy: ["bbbbbbbbbbbb"] })).toBe("unknown_id");
		expect(selection.propose({ id: "aaaaaaaaaaaa", reason: "duplicate", keptBy: ["aaaaaaaaaaaa"] })).toBe("invalid_kept_by");
		expect(selection.propose({ id: "aaaaaaaaaaaa", reason: "duplicate", keptBy: ["dddddddddddd"] })).toBe("invalid_kept_by");
		expect(selection.retiredIds()).toEqual([]);
	});

	it("never retires a reflection that covers an accepted retirement, nor covers with a retired one", () => {
		const selection = new RetirementSelection([refA, refB, refC]);
		selection.propose({ id: "aaaaaaaaaaaa", reason: "superseded", keptBy: ["bbbbbbbbbbbb"] });

		expect(selection.propose({ id: "bbbbbbbbbbbb", reason: "duplicate", keptBy: ["cccccccccccc"] })).toBe("kept_by_another");
		expect(selection.propose({ id: "cccccccccccc", reason: "duplicate", keptBy: ["aaaaaaaaaaaa"] })).toBe("invalid_kept_by");
		expect(selection.propose({ id: "aaaaaaaaaaaa", reason: "duplicate", keptBy: ["cccccccccccc"] })).toBe("already_retired");
		expect(selection.retiredIds()).toEqual(["aaaaaaaaaaaa"]);
	});
});

describe("runRetirer", () => {
	it("skips the model when fewer than two reflections are active", async () => {
		let called = false;
		const result = await runRetirer({
			model: {} as any,
			reflections: [refA],
			agentLoop: fakeAgentLoop(() => {
				called = true;
			}),
		});

		expect(result).toBeUndefined();
		expect(called).toBe(false);
	});

	it("shows dated reflections oldest first and returns only validated retirements", async () => {
		let userText = "";
		let toolText = "";
		const result = await runRetirer({
			model: {} as any,
			reflections: [refA, refB, refC],
			agentLoop: fakeAgentLoop(async (prompts, context) => {
				userText = prompts[0].content[0].text;
				const response = await context.tools[0].execute("tool-1", {
					retirements: [
						{ id: "aaaaaaaaaaaa", reason: "superseded", keptBy: ["bbbbbbbbbbbb"] },
						{ id: "bbbbbbbbbbbb", reason: "duplicate", keptBy: ["cccccccccccc"] },
					],
				});
				toolText = response.content[0].text;
			}),
		});

		expect(result).toEqual(["aaaaaaaaaaaa"]);
		expect(toolText).toBe("Retired 1 reflection. Rejected: bbbbbbbbbbbb (kept_by_another).");
		const lines = userText.split("\n");
		const indexA = lines.findIndex((line) => /^\[aaaaaaaaaaaa\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} Ticket X is blocked on review$/.test(line));
		const indexB = lines.findIndex((line) => /^\[bbbbbbbbbbbb\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} Ticket X merged after review$/.test(line));
		expect(indexA).toBeGreaterThan(-1);
		expect(indexB).toBeGreaterThan(indexA);
		expect(lines).toContain("[cccccccccccc] User prefers small PRs");
	});

	it("returns undefined when the model retires nothing", async () => {
		const result = await runRetirer({ model: {} as any, reflections: [refA, refB], agentLoop: fakeAgentLoop(() => {}) });

		expect(result).toBeUndefined();
	});

	it("throws a stream error when the model call failed and nothing was retired", async () => {
		const failed = { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } };

		await expect(runRetirer({
			model: {} as any,
			reflections: [refA, refB],
			agentLoop: fakeAgentLoop(() => {}, [failed]),
		})).rejects.toThrow(RetirerStreamError);
	});
});
