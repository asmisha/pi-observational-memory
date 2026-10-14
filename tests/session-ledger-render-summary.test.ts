import { describe, expect, it } from "vitest";

import { renderSummary, renderSummaryWithBudget } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

describe("session-ledger V3 summary rendering", () => {
	it("renders empty memory as an empty summary", () => {
		expect(renderSummary([], [])).toBe("");
	});

	it("keeps compacted-memory usage instructions", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });

		const summary = renderSummary([ref], []);

		expect(summary).toContain("These are condensed memories from earlier in this session.");
		expect(summary).toContain("use the recall tool");
	});

	it("renders V3 reflections with ids", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });

		const summary = renderSummary([ref], []);

		expect(summary).toContain("## Reflections\n[eeeeeeeeeeee] User prefers source-backed memory.");
	});

	it("renders a reflection's recording time in local time and tells the model the latest reflection wins", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], {
			content: "User prefers source-backed memory.",
			recordedAt: new Date(2026, 4, 2, 10, 30).toISOString(),
		});

		const summary = renderSummary([ref], []);

		expect(summary).toContain("## Reflections\n[eeeeeeeeeeee] 2026-05-02 10:30 User prefers source-backed memory.");
		expect(summary).toContain("the most recent observation reflects the latest known state, and among reflections the most recently recorded one wins.");
	});

	it("renders V3 observations with ids, timestamps, relevance, and content", () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User confirmed recall should use exact source entry ids.",
			timestamp: "2026-05-02 10:30",
			relevance: "high",
		});

		const summary = renderSummary([], [obs]);

		expect(summary).toContain(
			"## Observations\n[aaaaaaaaaaaa] 2026-05-02 10:30 [high] User confirmed recall should use exact source entry ids.",
		);
	});

	it("keeps raw provenance metadata out of the compact summary", () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["entry-user", "entry-tool"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

		const summary = renderSummary([ref], [obs]);

		expect(summary).not.toContain("sourceEntryIds");
		expect(summary).not.toContain("supportingObservationIds");
		expect(summary).not.toContain("entry-user");
		expect(summary).not.toContain("entry-tool");
		expect(summary).not.toContain("legacy");
		expect(summary).not.toContain("[object Object]");
	});
});

describe("budgeted summary rendering", () => {
	const reflections = ["e1", "e2", "e3"].map((id, i) => reflection(id.padEnd(12, "e"), ["aaaaaaaaaaaa"], { content: `Reflection ${i + 1} ${"r".repeat(120)}` }));
	const observations = ["a1", "a2", "a3", "a4"].map((id, i) => observation(id.padEnd(12, "a"), { content: `Observation ${i + 1} ${"o".repeat(120)}` }));

	it("renders everything when no budget is given", () => {
		const rendered = renderSummaryWithBudget(reflections, observations);

		expect(rendered.reflections).toHaveLength(3);
		expect(rendered.observations).toHaveLength(4);
		expect(rendered.omittedObservations).toBe(0);
		expect(rendered.text).not.toContain("omitted");
	});

	it("keeps all reflections and the newest observations that fit when reflections are small", () => {
		// Fixed overhead ~375 tokens, each line ~38 tokens. Budget 600 leaves
		// ~225: observations reserve half (2 lines), reflections take the rest
		// (3 lines fit), observations reclaim nothing more.
		const rendered = renderSummaryWithBudget(reflections, observations, { maxTokens: 600 });

		expect(rendered.reflections).toHaveLength(3);
		expect(rendered.observations.map((obs) => obs.id)).toEqual(["a3aaaaaaaaaa", "a4aaaaaaaaaa"]);
		expect(rendered.omittedReflections).toBe(0);
		expect(rendered.omittedObservations).toBe(2);
		expect(rendered.text).toContain("(2 older observations omitted to fit the summary budget");
		expect(rendered.text).toContain("[a4aaaaaaaaaa]");
		expect(rendered.text).not.toContain("[a1aaaaaaaaaa]");
	});

	it("guarantees observations at least half the budget when reflections are verbose", () => {
		const verbose = ["e1", "e2", "e3", "e4", "e5", "e6"].map((id, i) => reflection(id.padEnd(12, "e"), ["aaaaaaaaaaaa"], { content: `Reflection ${i + 1} ${"r".repeat(400)}` }));
		// ~225 tokens of lines: observations get >= 112 (2 lines), reflections the rest (1 line of ~105).
		const rendered = renderSummaryWithBudget(verbose, observations, { maxTokens: 578 });

		expect(rendered.observations.length).toBeGreaterThanOrEqual(2);
		expect(rendered.observations.at(-1)?.id).toBe("a4aaaaaaaaaa");
		expect(rendered.reflections.length).toBeGreaterThanOrEqual(1);
		expect(rendered.reflections.at(-1)?.id).toBe("e6eeeeeeeeee");
		expect(rendered.omittedReflections).toBeGreaterThan(0);
		expect(rendered.text).toContain("older reflection");
	});

	it("lets reflections use budget observations leave unused", () => {
		const oneObservation = observations.slice(0, 1);
		const rendered = renderSummaryWithBudget(reflections, oneObservation, { maxTokens: 578 });

		expect(rendered.observations).toHaveLength(1);
		expect(rendered.reflections).toHaveLength(3);
	});

	it("ignores a non-positive budget", () => {
		expect(renderSummary(reflections, observations, { maxTokens: 0 })).toBe(renderSummary(reflections, observations));
	});
});

describe("oversized newest record (PR #81 review, issue 3)", () => {
	it("still keeps a shorter older observation that fits", () => {
		const older = observation("a1aaaaaaaaaa", { content: "Short older fact." });
		const newest = observation("a2aaaaaaaaaa", { content: "x".repeat(4000) });

		const rendered = renderSummaryWithBudget([], [older, newest], { maxTokens: 500 });

		expect(rendered.observations.map((obs) => obs.id)).toEqual(["a1aaaaaaaaaa"]);
		expect(rendered.text).toContain("[a1aaaaaaaaaa] ");
		expect(rendered.text).toContain("Short older fact.");
	});
});

describe("latest user message cut off by compaction", () => {
	const request = {
		entryId: "u-request",
		timestamp: "2026-05-02T10:00:00.000Z",
		text: "Mikhail: как правильно отправить эти документы?\n\nФайл (photo): /tmp/attachments/52234/photo.jpg",
	};
	const facts = ["a1", "a2", "a3", "a4"].map((id, i) => observation(id.padEnd(12, "a"), { content: `Observation ${i + 1} ${"o".repeat(120)}` }));

	it("quotes the message verbatim after the memory records", () => {
		const text = renderSummary([], facts, { latestUserMessage: request });

		expect(text).toContain("## Latest user message");
		expect(text).toContain("> Mikhail: как правильно отправить эти документы?\n>\n> Файл (photo): /tmp/attachments/52234/photo.jpg");
		expect(text.indexOf("## Latest user message")).toBeGreaterThan(text.indexOf("## Observations"));
	});

	it("takes its share of the budget before records, so older records give way", () => {
		const without = renderSummaryWithBudget([], facts, { maxTokens: 600 });
		const withMessage = renderSummaryWithBudget([], facts, { maxTokens: 600, latestUserMessage: request });

		expect(withMessage.text).toContain("/tmp/attachments/52234/photo.jpg");
		expect(withMessage.observations.length).toBeLessThan(without.observations.length);
		expect(withMessage.observations.at(-1)?.id).toBe("a4aaaaaaaaaa");
	});

	it("truncates a long message to its budget share and points at the session entry", () => {
		const long = { ...request, text: `${"x".repeat(20_000)}TAIL` };

		const rendered = renderSummaryWithBudget([], facts, { maxTokens: 2_000, latestUserMessage: long });

		expect(rendered.text).not.toContain("TAIL");
		expect(rendered.text).toContain("more characters omitted to fit the summary budget; the full message is session entry u-request");
		expect(rendered.observations.length).toBeGreaterThan(0);
	});

	it("renders nothing without memory records, so the hook still delegates", () => {
		expect(renderSummaryWithBudget([], [], { latestUserMessage: request }).text).toBe("");
	});
});
