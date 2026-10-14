import { formatTimestamp } from "../serialize.js";
import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. Reflection lines show their id and, when known, the time they were recorded.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict about something that changed over time, the most recent observation reflects the latest known state, and among reflections the most recently recorded one wins. When entries disagree about something that did not change, such as what a document or source says, recency does not settle it: check the source or recall the entries before relying on either, especially before acting on it or telling the user an earlier answer was wrong. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return reflection.recordedAt
		? `[${reflection.id}] ${formatTimestamp(reflection.recordedAt)} ${reflection.content}`
		: `[${reflection.id}] ${reflection.content}`;
}

export type RenderSummaryOptions = {
	/**
	 * Estimated token budget for the rendered summary. Observations are
	 * guaranteed at least half of it (newest first); reflections take the rest
	 * (newest first), and whatever either side leaves unused goes to the other.
	 * Omitted records stay in the session ledger and remain visible through
	 * `/om:view full`.
	 */
	maxTokens?: number;
	/**
	 * The user's latest message, if compaction cut it off. It is quoted word for
	 * word after the memory records so the agent keeps the user's wording and
	 * file paths, which observations only paraphrase.
	 */
	latestUserMessage?: CutOffUserMessage;
};

export type CutOffUserMessage = {
	entryId: string;
	timestamp?: string;
	text: string;
};

/** Most tokens the quoted user message may use before it is cut short. */
export const LATEST_USER_MESSAGE_MAX_TOKENS = 2_000;
/** Largest share of the summary budget the quoted user message may use before it is cut short. */
export const LATEST_USER_MESSAGE_MAX_SHARE = 0.25;

const LATEST_USER_MESSAGE_HEADING = `## Latest user message\nThis is the user's latest message before the context below. Compaction removed it from context, so it is quoted here word for word:`;

function latestUserMessageSection(message: CutOffUserMessage, maxTokens: number | undefined): string {
	let text = message.text;
	if (maxTokens !== undefined) {
		const maxChars = Math.max(0, maxTokens * 4);
		if (text.length > maxChars) {
			text = `${text.slice(0, maxChars)}\n[… ${(text.length - maxChars).toLocaleString()} more characters cut to fit the summary budget; the full message is in session entry ${message.entryId}]`;
		}
	}
	const quoted = text.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">")).join("\n");
	return `${LATEST_USER_MESSAGE_HEADING}\n${formatTimestamp(message.timestamp)}\n${quoted}`;
}

/** Share of the summary budget reserved for observations before reflections are allocated. */
export const SUMMARY_OBSERVATIONS_MIN_SHARE = 0.5;

export type RenderedSummary = {
	text: string;
	reflections: Reflection[];
	observations: Observation[];
	omittedReflections: number;
	omittedObservations: number;
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Newest-first selection of records whose rendered lines fit `budget`, returned in original order. */
function selectWithinBudget<T>(records: T[], line: (record: T) => string, budget: number): { kept: T[]; tokens: number } {
	const keptIndexes: number[] = [];
	let tokens = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const cost = estimateTokens(line(records[i])) + 1;
		// Skip a record that does not fit instead of stopping: a single long
		// newest record must not hide shorter older ones that still fit.
		if (tokens + cost > budget) continue;
		tokens += cost;
		keptIndexes.push(i);
	}
	keptIndexes.reverse();
	return { kept: keptIndexes.map((i) => records[i]), tokens };
}

export function renderSummaryWithBudget(
	reflections: Reflection[],
	observations: Observation[],
	options: RenderSummaryOptions = {},
): RenderedSummary {
	if (reflections.length === 0 && observations.length === 0) {
		return { text: "", reflections: [], observations: [], omittedReflections: 0, omittedObservations: 0 };
	}

	let keptReflections = reflections;
	let keptObservations = observations;
	let latestUserMessage: string | undefined;
	const maxTokens = options.maxTokens;
	if (maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0) {
		const fixed = estimateTokens(CONTEXT_USAGE_INSTRUCTIONS) + estimateTokens("## Reflections\n## Observations\n\n\n\n") + 40;
		let budget = Math.max(0, maxTokens - fixed);
		// Quote the user's words first. Records about earlier work can be
		// recalled from the ledger; the cut-off request can't.
		if (options.latestUserMessage) {
			const messageMaxTokens = Math.min(LATEST_USER_MESSAGE_MAX_TOKENS, Math.floor(budget * LATEST_USER_MESSAGE_MAX_SHARE));
			latestUserMessage = latestUserMessageSection(options.latestUserMessage, messageMaxTokens);
			budget = Math.max(0, budget - estimateTokens(latestUserMessage) - 2);
		}
		// Observations are the chronological record and must not be crowded out
		// by verbose reflections: reserve them a share first, give reflections
		// the remainder, then let observations reclaim whatever reflections left.
		const reserved = selectWithinBudget(observations, observationToSummaryLine, Math.floor(budget * SUMMARY_OBSERVATIONS_MIN_SHARE));
		const pickedReflections = selectWithinBudget(reflections, reflectionToSummaryLine, budget - reserved.tokens);
		keptReflections = pickedReflections.kept;
		keptObservations = selectWithinBudget(observations, observationToSummaryLine, budget - pickedReflections.tokens).kept;
	} else if (options.latestUserMessage) {
		latestUserMessage = latestUserMessageSection(options.latestUserMessage, undefined);
	}

	const omittedReflections = reflections.length - keptReflections.length;
	const omittedObservations = observations.length - keptObservations.length;
	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (keptReflections.length > 0) {
		parts.push(`## Reflections\n${keptReflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (keptObservations.length > 0) {
		parts.push(`## Observations\n${keptObservations.map(observationToSummaryLine).join("\n")}`);
	}
	if (omittedReflections > 0 || omittedObservations > 0) {
		const omitted: string[] = [];
		if (omittedReflections > 0) omitted.push(`${omittedReflections} older reflection${omittedReflections === 1 ? "" : "s"}`);
		if (omittedObservations > 0) omitted.push(`${omittedObservations} older observation${omittedObservations === 1 ? "" : "s"}`);
		parts.push(`(${omitted.join(" and ")} omitted to fit the summary budget; they remain in the session memory ledger, see /om:view full.)`);
	}
	if (latestUserMessage) parts.push(latestUserMessage);
	return {
		text: parts.join("\n\n"),
		reflections: keptReflections,
		observations: keptObservations,
		omittedReflections,
		omittedObservations,
	};
}

export function renderSummary(reflections: Reflection[], observations: Observation[], options: RenderSummaryOptions = {}): string {
	return renderSummaryWithBudget(reflections, observations, options).text;
}
