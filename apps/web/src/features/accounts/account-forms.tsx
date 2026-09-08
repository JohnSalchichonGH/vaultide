'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { PositionDto } from '@vaultide/application';
import {
  closePositionAction,
  createCashAccountAction,
  createOtherAssetAction,
  deletePositionAction,
  updateCashAccountAction,
  updateOtherAssetAction,
} from '@/server/actions/positions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeMoneyInput } from '@/lib/money-input';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';

/**
 * Account and asset forms (blueprint 15.2, 16.6, 20.1, 20.3).
 *
 * Every form sends the `version` it was rendered from, so a change made in
 * another tab produces "changed elsewhere — reload" rather than silently
 * overwriting it. Nothing is optimistic: the server's answer is what the page
 * then shows.
 *
 * Dates are capped at today by the control **and** by the action's schema
 * **and** by the domain service. Three layers, because only the last two are
 * authorities and the first is a courtesy (20.1).
 */

const ACCOUNT_TYPES = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'cash', label: 'Cash' },
  { value: 'brokerage_cash', label: 'Brokerage cash' },
  { value: 'other', label: 'Other' },
] as const;

const ASSET_TYPES = [
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'collectible', label: 'Collectible' },
  { value: 'private_equity', label: 'Private equity' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'receivable', label: 'Money owed to me' },
  { value: 'custom', label: 'Something else' },
] as const;

export interface CurrencyOption {
  readonly code: string;
  readonly name: string;
}

function Status({ tone, children, testId }: { tone: 'error' | 'success'; children: ReactNode; testId?: string }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      data-testid={testId ?? `accounts-${tone}`}
      className="text-[length:var(--text-meta)]"
      style={{ color: tone === 'error' ? 'var(--color-negative)' : 'var(--color-positive)' }}
    >
      {children}
    </p>
  );
}

function Submit({ pending, children, testId }: { pending: boolean; children: ReactNode; testId?: string }) {
  const hydrated = useHydrated();
  return (
    <button
      type="submit"
      data-testid={testId}
      disabled={!hydrated || pending}
      className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
    >
      {pending ? 'Saving…' : children}
    </button>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  testId?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        className="w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 py-2"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Create a cash account (15.2), including the "new vs pre-existing" question. */
export function CreateCashAccountForm({
  currencies,
  baseCurrency,
  today,
  onCreated,
}: {
  currencies: readonly CurrencyOption[];
  baseCurrency: string;
  today: string;
  onCreated?: (id: string) => void;
}) {
  const router = useRouter();
  const ids = {
    name: useId(),
    currency: useId(),
    type: useId(),
    institution: useId(),
    balance: useId(),
    balanceOn: useId(),
    openedOn: useId(),
  };

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(baseCurrency);
  const [accountType, setAccountType] = useState<string>('checking');
  const [institution, setInstitution] = useState('');
  const [origin, setOrigin] = useState<'existing' | 'new'>('existing');
  const [openedOn, setOpenedOn] = useState(today);
  const [balance, setBalance] = useState('');
  const [balanceOn, setBalanceOn] = useState(today);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      data-testid="create-cash-account"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        const amount = normalizeMoneyInput(balance);

        startTransition(async () => {
          const result = await createCashAccountAction({
            name,
            currency,
            accountType,
            ...(institution.trim() === '' ? {} : { institution: institution.trim() }),
            ...(origin === 'new' ? { origin: 'new', openedOn } : { origin: 'existing' }),
            ...(amount === '' ? {} : { openingBalance: amount, openingBalanceOn: balanceOn }),
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved(`${result.data.name} added.`);
          setName('');
          setBalance('');
          router.refresh();
          onCreated?.(result.data.id);
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.name}>Account name</Label>
          <Input
            id={ids.name}
            data-testid="account-name"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>

        <Select
          id={ids.currency}
          testId="account-currency"
          label="Currency"
          value={currency}
          onChange={setCurrency}
          options={currencies.map((item) => ({ value: item.code, label: `${item.code} — ${item.name}` }))}
        />

        <Select
          id={ids.type}
          testId="account-type"
          label="Kind of account"
          value={accountType}
          onChange={setAccountType}
          options={ACCOUNT_TYPES}
        />

        <div className="space-y-1.5">
          <Label htmlFor={ids.institution}>Bank or institution (optional)</Label>
          <Input
            id={ids.institution}
            value={institution}
            onChange={(event) => {
              setInstitution(event.target.value);
            }}
          />
        </div>
      </div>

      <fieldset className="space-y-2 rounded-[var(--radius-control)] border p-3">
        <legend className="px-1 text-[length:var(--text-meta)] font-medium text-[var(--color-muted-foreground)]">
          Is this a new account?
        </legend>
        {/* Not cosmetic: an account that opened empty on a known date opens its
            month at zero, while a pre-existing account's first balance is
            excluded from that month rather than read as activity (8.1). */}
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="origin"
            data-testid="origin-existing"
            checked={origin === 'existing'}
            onChange={() => {
              setOrigin('existing');
            }}
          />
          <span>
            It already existed — I am starting to track it now.
            <span className="block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              Its first balance will be marked “first balance”, because what happened before it is
              not known.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="origin"
            data-testid="origin-new"
            checked={origin === 'new'}
            onChange={() => {
              setOrigin('new');
            }}
          />
          <span>It is new and started empty on a date I can give.</span>
        </label>

        {origin === 'new' ? (
          <div className="space-y-1.5 pl-6">
            <Label htmlFor={ids.openedOn}>Opened on</Label>
            <Input
              id={ids.openedOn}
              type="date"
              max={today}
              value={openedOn}
              className="tabular"
              onChange={(event) => {
                setOpenedOn(event.target.value);
              }}
            />
          </div>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.balance}>Balance today (optional)</Label>
          <Input
            id={ids.balance}
            data-testid="account-balance"
            inputMode="decimal"
            className="tabular text-right"
            value={balance}
            onChange={(event) => {
              setBalance(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.balanceOn}>…as it was on</Label>
          <Input
            id={ids.balanceOn}
            data-testid="account-balance-date"
            type="date"
            max={today}
            value={balanceOn}
            className="tabular"
            onChange={(event) => {
              setBalanceOn(event.target.value);
            }}
          />
          <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Today is {today}. Later dates are not accepted.
          </p>
        </div>
      </div>

      {error === null ? null : <Status tone="error">{error}</Status>}
      {saved === null ? null : <Status tone="success">{saved}</Status>}
      <Submit pending={pending} testId="account-submit">
        Add account
      </Submit>
    </form>
  );
}

/** Create an other asset, with the inclusion preference stated plainly (R18). */
export function CreateOtherAssetForm({
  currencies,
  baseCurrency,
  today,
}: {
  currencies: readonly CurrencyOption[];
  baseCurrency: string;
  today: string;
}) {
  const router = useRouter();
  const ids = { name: useId(), currency: useId(), type: useId(), value: useId(), valueOn: useId() };

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(baseCurrency);
  const [assetType, setAssetType] = useState<string>('vehicle');
  const [include, setInclude] = useState(false);
  const [value, setValue] = useState('');
  const [valueOn, setValueOn] = useState(today);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      data-testid="create-other-asset"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        const amount = normalizeMoneyInput(value);

        startTransition(async () => {
          const result = await createOtherAssetAction({
            name,
            currency,
            assetType,
            includeInFinancialNetWorth: include,
            ...(amount === '' ? {} : { currentValue: amount, currentValueOn: valueOn }),
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved(`${result.data.name} added.`);
          setName('');
          setValue('');
          router.refresh();
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.name}>What is it?</Label>
          <Input
            id={ids.name}
            data-testid="asset-name"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.currency}
          testId="asset-currency"
          label="Currency"
          value={currency}
          onChange={setCurrency}
          options={currencies.map((item) => ({ value: item.code, label: `${item.code} — ${item.name}` }))}
        />
        <Select
          id={ids.type}
          testId="asset-type"
          label="Kind"
          value={assetType}
          onChange={setAssetType}
          options={ASSET_TYPES}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.value}>What is it worth? (optional)</Label>
          <Input
            id={ids.value}
            data-testid="asset-value"
            inputMode="decimal"
            className="tabular text-right"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.valueOn}>…as it was on</Label>
          <Input
            id={ids.valueOn}
            data-testid="asset-value-date"
            type="date"
            max={today}
            value={valueOn}
            className="tabular"
            onChange={(event) => {
              setValueOn(event.target.value);
            }}
          />
        </div>
      </div>

      <label className="flex items-start gap-2 rounded-[var(--radius-control)] border p-3">
        <input
          type="checkbox"
          data-testid="asset-include"
          checked={include}
          onChange={(event) => {
            setInclude(event.target.checked);
          }}
        />
        <span>
          Count this in <strong>financial net worth</strong>
          <span className="block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            It counts in <strong>total net worth</strong> either way — nothing here can remove
            something you track from that. This only decides whether it belongs in the headline
            figure alongside cash and investments.
          </span>
        </span>
      </label>

      {error === null ? null : <Status tone="error">{error}</Status>}
      {saved === null ? null : <Status tone="success">{saved}</Status>}
      <Submit pending={pending} testId="asset-submit">
        Add asset
      </Submit>
    </form>
  );
}

/** Rename, mark dormant, and — for other assets — set the inclusion preference. */
export function EditPositionForm({ position, today }: { position: PositionDto; today: string }) {
  const router = useRouter();
  const nameId = useId();
  const [name, setName] = useState(position.name);
  const [include, setInclude] = useState(position.includeInFinancialNetWorth === true);
  const [dormant, setDormant] = useState(position.isDormant === true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const isCash = position.kind === 'cash';

  return (
    <form
      className="space-y-4"
      data-testid="edit-position"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        startTransition(async () => {
          const result = isCash
            ? await updateCashAccountAction({
                positionId: position.id,
                expectedVersion: position.version,
                name,
                isDormant: dormant,
              })
            : await updateOtherAssetAction({
                positionId: position.id,
                expectedVersion: position.version,
                name,
                includeInFinancialNetWorth: include,
              });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved('Saved.');
          router.refresh();
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          data-testid="edit-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>

      {isCash ? (
        /*
         * Dormant (6.2, R22): the only account state that carries at zero
         * without a monthly confirmation. The server refuses it unless the
         * latest balance is exactly zero, and clears it again the moment a
         * non-zero balance is recorded — so the flag can never quietly assert
         * "still empty" about an account that is not.
         */
        <label className="flex items-start gap-2 rounded-[var(--radius-control)] border p-3">
          <input
            type="checkbox"
            data-testid="edit-dormant"
            checked={dormant}
            onChange={(event) => {
              setDormant(event.target.checked);
            }}
          />
          <span>
            This account is <strong>dormant</strong>
            <span className="block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              Empty and left open. A dormant account carries at zero without being confirmed
              every month, and is left out of the quick update. It can only be marked dormant
              while its balance is exactly zero, and recording anything in it again turns this
              off.
            </span>
          </span>
        </label>
      ) : (
        <label className="flex items-start gap-2 rounded-[var(--radius-control)] border p-3">
          <input
            type="checkbox"
            data-testid="edit-include"
            checked={include}
            onChange={(event) => {
              setInclude(event.target.checked);
            }}
          />
          <span>
            Count this in <strong>financial net worth</strong>
            <span className="block text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
              Total net worth does not change either way.
            </span>
          </span>
        </label>
      )}

      {error === null ? null : <Status tone="error">{error}</Status>}
      {saved === null ? null : <Status tone="success">{saved}</Status>}
      <div className="flex flex-wrap items-center gap-3">
        <Submit pending={pending} testId="edit-submit">
          Save
        </Submit>
        <PositionLifecycleButtons position={position} today={today} />
      </div>
    </form>
  );
}

/**
 * Close and delete (M6, R12, 6.3).
 *
 * Separate from the edit form because they are not edits: closing changes
 * whether the position counts towards net worth at all, and it is refused
 * outright while a balance remains — with a sentence saying what to do instead,
 * rather than a constraint violation. Deleting is possible only while there is
 * no history to lose.
 *
 * There is no archive button. §25 gives Phase 2 "create/edit/close", and what
 * archiving means for net worth is 12.3's "removed from tracking" — which needs
 * the date it was removed on, and belongs with the decomposition in Phase 7.
 */
function PositionLifecycleButtons({ position, today }: { position: PositionDto; today: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error?.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {position.status === 'active' ? (
        <button
          type="button"
          data-testid="close-position"
          disabled={pending}
          className="rounded-[var(--radius-control)] border px-3 py-2"
          onClick={() => {
            run(() =>
              closePositionAction({
                positionId: position.id,
                expectedVersion: position.version,
                closedOn: today,
              }),
            );
          }}
        >
          Close
        </button>
      ) : null}

      {position.valuationCount === 0 ? (
        <button
          type="button"
          data-testid="delete-position"
          disabled={pending}
          className="rounded-[var(--radius-control)] border border-[var(--color-negative)] px-3 py-2 text-[var(--color-negative)]"
          onClick={() => {
            run(() => deletePositionAction({ positionId: position.id }));
          }}
        >
          Delete
        </button>
      ) : null}

      {error === null ? null : (
        <span
          role="alert"
          data-testid="lifecycle-error"
          className={cn('text-[length:var(--text-meta)] text-[var(--color-negative)]')}
        >
          {error}
        </span>
      )}
    </div>
  );
}
