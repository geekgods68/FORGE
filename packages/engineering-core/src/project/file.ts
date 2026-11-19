import { loadProjectDocument, type DocumentResult } from './migrate';
import type { Project } from './schema';

// Available in browsers and Node ≥ 11; declared locally because this package does not load DOM types.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

/**
 * `.forge.json` file format: the current-version project document as canonical JSON
 * (object keys sorted recursively, 2-space indentation, trailing newline), so the
 * same engineering state always produces byte-identical files.
 */
export const PROJECT_FILE_EXTENSION = '.forge.json';
/** Import guard against resource-exhausting files (10 MiB of text). */
export const MAX_PROJECT_FILE_BYTES = 10 * 1024 * 1024;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Canonical JSON: recursively sorted keys, so equal data always yields identical text. */
export function canonicalStringify(value: unknown, indent?: number): string {
  return JSON.stringify(canonicalize(value), null, indent);
}

export function serializeProject(project: Project): string {
  return JSON.stringify(canonicalize(project), null, 2) + '\n';
}

/** Parse untrusted file text into a validated project. Never throws. */
export function parseProjectFile(text: string): DocumentResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_PROJECT_FILE_BYTES)
    return {
      ok: false,
      error: {
        code: 'too-large',
        message: `File is ${(bytes / 1048576).toFixed(1)} MiB; the limit is ${MAX_PROJECT_FILE_BYTES / 1048576} MiB.`,
      },
    };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'corrupt',
        message: `File is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
      },
    };
  }
  return loadProjectDocument(doc);
}

/** Filesystem-safe download name derived from the project name. */
export function projectFileName(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'forge-project';
  return `${base}${PROJECT_FILE_EXTENSION}`;
}
