import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { jsonrepair } from "jsonrepair";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Best-effort repair of malformed JSON.
 *
 * Wraps `jsonrepair`, which tolerates common mistakes such as missing quotes,
 * trailing commas, comments, single quotes and unquoted keys, returning a valid
 * JSON string. Throws if the input cannot be salvaged into valid JSON.
 */
export function fixJsonInput(input: string): string {
	return jsonrepair(input);
}

/**
 * Repairs and pretty-prints a JSON string with 2-space indentation.
 *
 * Throws if the input cannot be repaired into valid JSON.
 */
export function formatJson(input: string): string {
	return JSON.stringify(JSON.parse(fixJsonInput(input)), null, 2);
}

export type JsonProcessResult =
	| { status: "ok"; output: string }
	| { status: "repaired"; output: string; message: string }
	| { status: "error"; message: string };

/**
 * Processes a JSON string and reports how it was handled:
 *
 * - `ok`: the input was already valid JSON.
 * - `repaired`: the input was malformed but could be repaired; `message`
 *   describes the original parse issue.
 * - `error`: the input could not be processed into valid JSON at all.
 */
export function processJsonInput(input: string): JsonProcessResult {
	try {
		return { status: "ok", output: JSON.stringify(JSON.parse(input), null, 2) };
	} catch (parseError) {
		try {
			const output = JSON.stringify(JSON.parse(fixJsonInput(input)), null, 2);
			return {
				status: "repaired",
				output,
				message: parseError instanceof Error ? parseError.message : "Malformed JSON"
			};
		} catch (repairError) {
			return {
				status: "error",
				message:
					repairError instanceof Error ? repairError.message : "Unable to process JSON"
			};
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
