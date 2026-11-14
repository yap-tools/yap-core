/**
 * The one parser for a stored-file reference: `file://{uuid}` or the bare
 * uuid. Shared by the bundle reader (services.ts), which refuses anything
 * else, and by drivers that check a reference's shape before handing it to
 * the reader, so the two can never disagree about what a reference is.
 */
export const FILE_REF_PREFIX = "file://";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The file id a reference names, or null when it is not a reference. */
export function parseFileRef(refOrId: string): string | null {
  const ref = refOrId.trim();
  const id = ref.startsWith(FILE_REF_PREFIX) ? ref.slice(FILE_REF_PREFIX.length) : ref;
  return UUID_RE.test(id) ? id : null;
}
