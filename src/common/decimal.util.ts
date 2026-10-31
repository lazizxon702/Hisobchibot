import { Decimal } from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export class DecimalUtil {
  static toDecimal(val: string | number | Decimal | null | undefined): Decimal {
    if (val === null || val === undefined || val === '') {
      return new Decimal(0);
    }
    return new Decimal(val);
  }

  static add(a: string | number | Decimal, b: string | number | Decimal): Decimal {
    return this.toDecimal(a).plus(this.toDecimal(b));
  }

  static sub(a: string | number | Decimal, b: string | number | Decimal): Decimal {
    return this.toDecimal(a).minus(this.toDecimal(b));
  }

  static mul(a: string | number | Decimal, b: string | number | Decimal): Decimal {
    return this.toDecimal(a).times(this.toDecimal(b));
  }

  static div(a: string | number | Decimal, b: string | number | Decimal): Decimal {
    const divisor = this.toDecimal(b);
    if (divisor.isZero()) {
      throw new Error('Division by zero');
    }
    return this.toDecimal(a).dividedBy(divisor);
  }

  static isGreaterThan(a: string | number | Decimal, b: string | number | Decimal): boolean {
    return this.toDecimal(a).greaterThan(this.toDecimal(b));
  }

  static isGreaterThanOrEqual(a: string | number | Decimal, b: string | number | Decimal): boolean {
    return this.toDecimal(a).greaterThanOrEqualTo(this.toDecimal(b));
  }

  static isLessThan(a: string | number | Decimal, b: string | number | Decimal): boolean {
    return this.toDecimal(a).lessThan(this.toDecimal(b));
  }

  static isEqual(a: string | number | Decimal, b: string | number | Decimal): boolean {
    return this.toDecimal(a).equals(this.toDecimal(b));
  }

  static isZero(a: string | number | Decimal): boolean {
    return this.toDecimal(a).isZero();
  }

  static isPositive(a: string | number | Decimal): boolean {
    return this.toDecimal(a).isPositive() && !this.toDecimal(a).isZero();
  }

  static toFixed2(val: string | number | Decimal): string {
    return this.toDecimal(val).toFixed(2);
  }

  static formatMoney(val: string | number | Decimal, currency: string = 'UZS'): string {
    const dec = this.toDecimal(val);
    const parts = dec.toFixed(2).split('.');
    const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const decimalPart = parts[1] === '00' ? '' : `.${parts[1]}`;
    return `${integerPart}${decimalPart} ${currency}`;
  }
}
