/** Save text as a local file download (no network). */
export function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Bundles and assemblies may embed model bytes (base64): larger limit than plain projects. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
