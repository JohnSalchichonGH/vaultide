import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SignInForm } from '@/features/auth/forms';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default function SignInPage() {
  // The form reads `?next=` to return the user where they were heading, which
  // needs a suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
