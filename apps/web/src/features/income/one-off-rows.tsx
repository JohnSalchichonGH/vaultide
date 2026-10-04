'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import type { IncomeOneOffDto } from '@vaultide/application';
import { Amount, META, type Formatting } from '@/features/spending/figure';
import { dayTitle } from '@/features/monthly/presentation';
import { SETTLEMENT_LABEL, incomeKindLabel } from '@/features/monthly/income-presentation';
import { GrossCell, NativeNote } from '@/features/income/cells';
import { incomeFigureDisplay, paymentCount, paymentHref } from '@/features/income/presentation';

/**
 * The "One-off payments" row of the sources table, and what it expands into
 * (ADR 0012 D1, D5): the year's payments without a recurring source, by kind,
 * each linking to the Monthly month that holds it — the one place they are
 * edited. The page lists no other entry.
 */
export function OneOffRows({
  oneOff,
  showGross,
  reportingCurrency,
  formatting,
}: {
  readonly oneOff: IncomeOneOffDto;
  readonly showGross: boolean;
  readonly reportingCurrency: string;
  readonly formatting: Formatting;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const cell = 'py-2 pr-2 text-right sm:pr-4';

  return (
    <>
      <tbody data-testid="income-one-off">
        <tr className="border-t">
          <th scope="row" className="py-2 pr-2 text-left font-normal sm:pr-4">
            <button
              type="button"
              className="text-left underline"
              aria-expanded={open}
              aria-controls={panel}
              data-testid="income-one-off-toggle"
              onClick={() => {
                setOpen((current) => !current);
              }}
            >
              One-off payments
            </button>
            <span className={`block ${META}`}>No recurring source</span>
          </th>
          <td className={cell}>
            <Amount display={incomeFigureDisplay(oneOff.total.net)} formatting={formatting} />
            <NativeNote native={oneOff.total.native} reportingCurrency={reportingCurrency} formatting={formatting} />
          </td>
          {showGross ? <GrossCell gross={oneOff.total.gross} formatting={formatting} className={cell} /> : null}
          <td className={`${cell} ${META}`}>{paymentCount(oneOff.total.count)}</td>
        </tr>
      </tbody>
      {/* Always rendered, so `aria-controls` names an element that exists. */}
      <tbody id={panel} hidden={!open} data-testid="income-one-off-payments">
        {oneOff.kinds.flatMap((group) => [
          <tr key={group.kind} className="bg-[var(--color-surface-muted)]" data-testid="income-one-off-kind" data-kind={group.kind}>
            <th scope="row" className="py-1.5 pr-2 pl-3 text-left font-medium sm:pr-4">
              {incomeKindLabel(group.kind)}
            </th>
            <td className={cell}>
              <Amount display={incomeFigureDisplay(group.total.net)} formatting={formatting} />
            </td>
            {showGross ? <GrossCell gross={group.total.gross} formatting={formatting} className={cell} /> : null}
            <td className={`${cell} ${META}`}>{paymentCount(group.total.count)}</td>
          </tr>,
          ...group.payments.map((payment) => (
            <tr key={payment.entryId} data-testid="income-one-off-payment" data-entry-id={payment.entryId}>
              <th scope="row" className="py-1.5 pr-2 pl-6 text-left font-normal sm:pr-4">
                <Link href={paymentHref(payment.entryId, payment.receivedOn)} className="underline">
                  {dayTitle(payment.receivedOn, formatting.locale)}
                </Link>
                <span className={`block ${META}`}>
                  {SETTLEMENT_LABEL[payment.settlement] ?? payment.settlement}
                  {payment.description === null ? null : ` · ${payment.description}`}
                </span>
              </th>
              <td className={cell}>
                <Amount display={incomeFigureDisplay(payment.reporting)} formatting={formatting} />
                <NativeNote native={[payment.net]} reportingCurrency={reportingCurrency} formatting={formatting} />
              </td>
              {showGross ? (
                <td className={cell}>
                  {payment.reportingGross === null ? (
                    <span className={META}>No gross</span>
                  ) : (
                    <Amount display={incomeFigureDisplay(payment.reportingGross)} formatting={formatting} />
                  )}
                </td>
              ) : null}
              <td className={cell} />
            </tr>
          )),
        ])}
      </tbody>
    </>
  );
}
