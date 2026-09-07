'use client';

import { useEffect, useState } from 'react';

/**
 * Whether React has hydrated this component.
 *
 * Every form in Vaultide is a controlled React form: the submit handler runs in
 * JavaScript, and the inputs are driven by state. Between the server HTML
 * arriving and React taking it over, that form looks usable and is not — a
 * click does nothing at all, and anything typed is discarded the moment React
 * first renders from its own empty state.
 *
 * Buttons therefore stay disabled until this returns `true`. It is a fraction
 * of a second on any real connection, and it is the difference between "the
 * button did nothing" and "the button was not ready yet".
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
