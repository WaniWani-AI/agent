export type AttachedDocument = { documentId: string; filename: string; mediaType: string };

/** The chat route's limits, so a document the app would refuse never reaches a tool. */
const MAX_DOCUMENTS = 10;
const MAX_FILENAME = 255;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABELS: Record<string, string> = {
	"application/pdf": "PDF",
	"image/png": "image",
	"image/jpeg": "image",
	"image/tiff": "image",
	"image/bmp": "image",
	"image/gif": "image",
	"image/webp": "image",
};

function document(value: unknown): AttachedDocument | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { documentId, filename, mediaType } = value as Record<string, unknown>;
	return typeof documentId === "string" &&
		UUID.test(documentId) &&
		typeof filename === "string" &&
		filename.length > 0 &&
		filename.length <= MAX_FILENAME &&
		typeof mediaType === "string" &&
		Object.hasOwn(LABELS, mediaType)
		? { documentId, filename, mediaType }
		: undefined;
}

/** `[]` for an absent header, `null` for one the app would have refused. */
export function parseAttachedDocuments(raw: string | null): AttachedDocument[] | null {
	if (raw === null) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) return null;
	const documents = value.map(document);
	return documents.every((entry) => entry !== undefined) ? documents : null;
}

export function attachedDocumentsOf(attribute: unknown): AttachedDocument[] {
	return typeof attribute === "string" ? (parseAttachedDocuments(attribute) ?? []) : [];
}

/**
 * The note the chat route adds for the same turn. It names only the count and
 * the type: filenames are visitor-supplied and reach tools through `_meta`.
 */
export function attachedDocumentsNote(documents: AttachedDocument[]): string {
	const kinds = [...new Set(documents.map((entry) => LABELS[entry.mediaType]))];
	const what =
		documents.length === 1
			? `${kinds[0] === "image" ? "an" : "a"} ${kinds[0]}`
			: `${documents.length} files`;
	return [
		`The visitor attached ${what} to the latest message.`,
		"You cannot read the bytes yourself, but a tool can read them for you: a screenshot or a photo is read exactly like a PDF.",
		"If one of your tools reads attached files, call it whatever the file's type: the ids are on this request.",
		"Only if you have no such tool, say you cannot read the attachment and ask for what you need instead.",
	].join(" ");
}
