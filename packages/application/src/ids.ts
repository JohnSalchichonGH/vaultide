/**
 * A canonical UUID, the shape of every row id.
 *
 * An id read from an address is not trusted to be one. Anything else names no
 * row, and handed to a `uuid` column the database would refuse it rather than
 * find nothing — so a read keyed by such an id asks this first, and answers
 * "not found" without a query.
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isCanonicalUuid(value: string): boolean {
  return ID_PATTERN.test(value);
}
