/**
 * Raggruppamento dei documenti della cronologia per data, così che la pagina
 * non sia un unico elenco piatto che cresce all'infinito:
 *
 * - mese corrente: i documenti restano in cima, senza cartella;
 * - mesi precedenti dello stesso anno: una cartella per mese ("Gennaio", …);
 * - anni precedenti: una cartella per anno ("2024", "2025"), piatta all'interno.
 *
 * Il criterio è `updatedAt`, lo stesso con cui listDocuments() ordina: un
 * documento ripreso oggi torna quindi in cima invece di restare sepolto nella
 * cartella del mese in cui era stato creato.
 */

import type { DocumentRecord } from "$lib/history-db";

export interface HistoryGroup {
	key: string;
	label: string;
	documents: DocumentRecord[];
}

export interface GroupedHistory {
	/** Documenti del mese corrente, mostrati fuori da ogni cartella. */
	current: DocumentRecord[];
	/** Cartelle, dalla più recente alla più vecchia. */
	groups: HistoryGroup[];
}

// Segue la locale del browser, come il toLocaleString() usato per le date.
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: "long" });

function monthLabel(monthIndex: number): string {
	// Anno non bisestile qualsiasi: serve solo a costruire una data nel mese giusto.
	const label = monthFormatter.format(new Date(2021, monthIndex, 1));
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Suddivide i documenti (già ordinati per `updatedAt` decrescente) nei gruppi
 * descritti sopra, preservando l'ordine ricevuto dentro ogni gruppo.
 */
export function groupDocuments(documents: DocumentRecord[], now = Date.now()): GroupedHistory {
	const reference = new Date(now);
	const currentYear = reference.getFullYear();
	const currentMonth = reference.getMonth();

	const current: DocumentRecord[] = [];
	// Map preserva l'ordine di inserimento: scorrendo documenti già ordinati dal
	// più recente, i gruppi risultano automaticamente dal più recente al più vecchio.
	const groups = new Map<string, HistoryGroup>();

	const push = (key: string, label: string, document: DocumentRecord) => {
		const group = groups.get(key);
		if (group) {
			group.documents.push(document);
			return;
		}
		groups.set(key, { key, label, documents: [document] });
	};

	for (const document of documents) {
		const updated = new Date(document.updatedAt);
		const year = updated.getFullYear();
		if (year !== currentYear) {
			push(`year-${year}`, String(year), document);
			continue;
		}
		const month = updated.getMonth();
		if (month === currentMonth) {
			current.push(document);
			continue;
		}
		push(`month-${month}`, monthLabel(month), document);
	}

	return { current, groups: [...groups.values()] };
}
