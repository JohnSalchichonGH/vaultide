import {
  archiveCategory,
  deleteTag,
  insertCategory,
  insertTag,
  listCategoryRecords,
  listTagRecords,
  renameCategory,
  type CategoryRecord,
  type Database,
} from '@vaultide/db';
import { isSystemCategoryKind, type CategoryKind } from '@vaultide/validation';
import { ImpossibleOperationError, NotFoundError } from '../errors';

/**
 * Categories and tags (blueprint 6.2, 6.3, 15.2 Settings, T5, T6).
 *
 * Phase 1 builds the infrastructure and the settings screen that manages it;
 * nothing files an expense under a category until Phase 3. The one rule with
 * teeth already is that a **system** category cannot be archived: the seven
 * system kinds carry the non-consumption accounting semantics of 7.4, and the
 * engines from Phase 3 onward assume one of each exists.
 */

export interface Category {
  readonly id: string;
  readonly kind: CategoryKind;
  readonly name: string;
  readonly groupName: string | null;
  readonly isDefault: boolean;
  readonly isSystem: boolean;
  readonly sortOrder: number;
  readonly archived: boolean;
  readonly version: number;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
}

function toDto(row: CategoryRecord): Category {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    groupName: row.groupName,
    isDefault: row.isDefault,
    isSystem: isSystemCategoryKind(row.kind),
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
    version: row.version,
  };
}

export async function listCategories(
  db: Database,
  userId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Category[]> {
  const rows = await listCategoryRecords(db, userId, options);
  return rows.map(toDto);
}

export async function listTags(db: Database, userId: string): Promise<Tag[]> {
  const rows = await listTagRecords(db, userId);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function createCategory(
  db: Database,
  userId: string,
  input: { kind: CategoryKind; name: string; groupName?: string | null },
): Promise<Category> {
  if (isSystemCategoryKind(input.kind)) {
    // One of each system kind exists per user, created at sign-up. A second
    // would make "the investment-fee category" ambiguous for every engine that
    // looks one up by kind.
    throw new ImpossibleOperationError(
      'That category kind is managed by Vaultide and already exists on your account.',
    );
  }
  const row = await insertCategory(db, userId, input);
  /* v8 ignore next -- an insert either returns its row or throws. */
  if (row === undefined) throw new NotFoundError();
  return toDto(row);
}

export async function archiveUserCategory(
  db: Database,
  userId: string,
  categoryId: string,
): Promise<Category> {
  const existing = (await listCategoryRecords(db, userId, { includeArchived: true })).find(
    (row) => row.id === categoryId,
  );
  // A category belonging to somebody else is simply not found: existence is
  // never leaked (17.2).
  if (existing === undefined) throw new NotFoundError();

  if (isSystemCategoryKind(existing.kind)) {
    throw new ImpossibleOperationError(
      'System categories cannot be archived: they carry accounting meaning Vaultide relies on.',
    );
  }

  const row = await archiveCategory(db, userId, categoryId);
  /* v8 ignore next -- the row was just read inside the same user scope. */
  if (row === undefined) throw new NotFoundError();
  return toDto(row);
}

export async function renameUserCategory(
  db: Database,
  userId: string,
  categoryId: string,
  name: string,
): Promise<Category> {
  const row = await renameCategory(db, userId, categoryId, name);
  if (row === undefined) throw new NotFoundError();
  return toDto(row);
}

export async function createTag(db: Database, userId: string, name: string): Promise<Tag> {
  const row = await insertTag(db, userId, name);
  /* v8 ignore next -- an insert either returns its row or throws. */
  if (row === undefined) throw new NotFoundError();
  return { id: row.id, name: row.name };
}

export async function removeTag(db: Database, userId: string, tagId: string): Promise<void> {
  const deleted = await deleteTag(db, userId, tagId);
  if (deleted === 0) throw new NotFoundError();
}
