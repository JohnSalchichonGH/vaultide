import { Decimal } from '../decimal';
import { foldAvailable, type Aggregate, type Maybe } from '../unavailable';
import { money, add as addMoney, zero } from './money';
import { currencyCode, type CurrencyCode, type Money } from './types';

/**
 * A multi-currency total (blueprint 7.6). Amounts of different currencies are
 * never added together; they are kept side by side until something converts
 * them, and conversion is injected so this module stays free of FX IO.
 */
export class MoneyBag {
  readonly #entries = new Map<CurrencyCode, Decimal>();

  static from(items: readonly Money[]): MoneyBag {
    const bag = new MoneyBag();
    for (const item of items) bag.add(item);
    return bag;
  }

  add(item: Money): this {
    const current = this.#entries.get(item.currency) ?? new Decimal(0);
    this.#entries.set(item.currency, current.plus(item.amount));
    return this;
  }

  addAll(items: readonly Money[]): this {
    for (const item of items) this.add(item);
    return this;
  }

  get(currency: CurrencyCode | string): Money {
    const code = currencyCode(currency);
    const amount = this.#entries.get(code);
    return amount === undefined ? zero(code) : { amount, currency: code };
  }

  currencies(): CurrencyCode[] {
    return [...this.#entries.keys()].sort();
  }

  entries(): Money[] {
    return this.currencies().map((currency) => this.get(currency));
  }

  isEmpty(): boolean {
    return this.#entries.size === 0;
  }

  /**
   * Convert every bucket into one currency with an injected converter. A bucket
   * the converter cannot value makes the result partial — never silently zero.
   */
  convert(to: CurrencyCode | string, convert: (from: Money) => Maybe<Money>): Aggregate<Money> {
    const target = currencyCode(to);
    const converted = this.entries().map((item) =>
      item.currency === target ? item : convert(item),
    );
    return foldAvailable(converted, money('0', target), (acc, item) => addMoney(acc, item));
  }
}
