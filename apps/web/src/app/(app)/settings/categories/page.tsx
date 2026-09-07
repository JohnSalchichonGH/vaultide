import type { Metadata } from 'next';
import { getServices, listCategories, listTags } from '@vaultide/application';
import { settingsInput } from '@vaultide/validation';
import { requireSessionPage } from '@/server/context';
import { CategoriesManager } from '@/features/settings/settings-forms';

export const metadata: Metadata = { title: 'Categories & tags' };
export const dynamic = 'force-dynamic';

/** Settings → Categories and tags (blueprint 15.2, 6.2, T5, T6). */
export default async function CategorySettingsPage() {
  const session = await requireSessionPage('/settings/categories');
  const db = getServices().db;

  const [categories, tags] = await Promise.all([
    listCategories(db, session.userId),
    listTags(db, session.userId),
  ]);

  return (
    <CategoriesManager
      categories={categories}
      tags={tags}
      kinds={[...settingsInput.CATEGORY_KINDS_FOR_USERS]}
    />
  );
}
