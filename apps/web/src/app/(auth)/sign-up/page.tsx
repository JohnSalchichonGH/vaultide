import type { Metadata } from 'next';
import { SignUpForm } from '@/features/auth/forms';

export const metadata: Metadata = { title: 'Create an account' };
export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return <SignUpForm />;
}
