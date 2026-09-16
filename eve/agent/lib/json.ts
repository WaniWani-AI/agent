export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };
