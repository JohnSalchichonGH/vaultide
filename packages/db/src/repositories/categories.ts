import { and, asc, eq, isNull } from 'drizzle-orm';
import { categories } from '../schema/categories';
import { tags } from '../schema/tags';
import { withUser, type Database, type Transaction } from '../client';

/**
 * `categories` and `tags` reads and writes (blueprint 6.2, 6.3).
 *
 * User-owned, so every statement runs inside `withUser` and the policy is the
 * backstop for the `WHERE` clause. Categories are **archived**, never deleted
 * while referenced (R12); tags may be deleted outright, because nothing points
 * at a tag row — flows carry their labels as a `text[]` (D24).
 */

export type CategoryRecord = typeof categories.$inferSelect;
export type TagRecord = typeof tags.$inferSelect;

export async function listCategoryRecords(
  db: Database,
  userId: string,
  options: { includeArchived?: boolean } = {},
): Promise<CategoryRecord[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(categories)
      .where(options.includeArchived === true ? undefined : isNull(categories.archivedAt))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
  );
}

/**
 * One category by id, **archived rows included**, inside an existing scope.
 *
 * For the callers that need a category's accounting `kind` rather than its
 * availability: an occurrence materialized from a template that was made when
 * the category was live is still that kind of expense, so archiving a category
 * must not change what an already scheduled occurrence *is*. Whether a category
 * may be chosen afresh is the separate question `listCategoryRecords` answers
 * for the paths that ask it.
 */
export async function findCategoryIn(
  tx: Transaction,
  categoryId: string,
): Promise<CategoryRecord | undefined> {
  const [row] = await tx
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  return row;
}

export async function listTagRecords(db: Database, userId: string): Promise<TagRecord[]> {
  return withUser(db, { userId }, async (tx) =>
    tx.select().from(tags).orderBy(asc(tags.name)),
  );
}

export async function insertCategory(
  db: Database,
  userId: string,
  input: { kind: CategoryRecord['kind']; name: string; groupName?: string | null },
): Promise<CategoryRecord | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .insert(categories)
      .values({
        userId,
        kind: input.kind,
        name: input.name,
        groupName: input.groupName ?? null,
      })
      .returning(),
  );
  return row;
}

/** Archiving keeps the name free for a new category and the history intact. */
export async function archiveCategory(
  db: Database,
  userId: string,
  categoryId: string,
): Promise<CategoryRecord | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .update(categories)
      .set({ archivedAt: new Date() })
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
      .returning(),
  );
  return row;
}

export async function renameCategory(
  db: Database,
  userId: string,
  categoryId: string,
  name: string,
): Promise<CategoryRecord | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .update(categories)
      .set({ name })
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
      .returning(),
  );
  return row;
}

export async function insertTag(
  db: Database,
  userId: string,
  name: string,
): Promise<TagRecord | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.insert(tags).values({ userId, name }).returning(),
  );
  return row;
}

export async function deleteTag(db: Database, userId: string, tagId: string): Promise<number> {
  const rows = await withUser(db, { userId }, async (tx) =>
    tx
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
      .returning({ id: tags.id }),
  );
  return rows.length;
}
