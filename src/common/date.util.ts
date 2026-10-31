import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Tashkent';

export class DateUtil {
  static nowUtc(): Date {
    return new Date();
  }

  static formatTashkent(date: Date | string | null | undefined, format: string = 'DD.MM.YYYY HH:mm'): string {
    if (!date) return '—';
    return dayjs(date).tz(TIMEZONE).format(format);
  }

  static formatDateTashkent(date: Date | string | null | undefined): string {
    return this.formatTashkent(date, 'DD.MM.YYYY');
  }

  static parseToUtcDate(dateStr: string): Date | null {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const trimmed = dateStr.trim();

    // Support DD.MM.YYYY or DD/MM/YYYY or YYYY-MM-DD
    const formats = ['DD.MM.YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY HH:mm'];
    for (const fmt of formats) {
      const parsed = dayjs.tz(trimmed, fmt, TIMEZONE);
      if (parsed.isValid()) {
        return parsed.utc().toDate();
      }
    }
    return null;
  }

  static isValidDate(dateStr: string): boolean {
    return this.parseToUtcDate(dateStr) !== null;
  }

  static isPastDate(date: Date): boolean {
    return dayjs(date).isBefore(dayjs());
  }

  static addDays(date: Date, days: number): Date {
    return dayjs(date).add(days, 'day').toDate();
  }
}
