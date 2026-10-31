import { describe, it, expect } from 'vitest';
import { formatReceiptText } from '../src/bot/bot.service';

describe('Quick Check Receipt Formatter & Calculations', () => {
  it('should format receipt text to exactly match user specification', () => {
    const sampleOrder = {
      id: 'ad025e2d-8389-4724-939f-d9442ed3c6bc',
      checkNumber: 3531,
      omborStatus: 'Tasdiqlash kutilmoqda',
      createdAt: new Date('2026-10-31T20:43:54+05:00'),
      seller: {
        firstName: 'Исфандиёр',
        lastName: 'Исроилов',
        telegramId: BigInt('2038308226'),
      },
      program: {
        name: 'Payme',
      },
      totalPrice: '1300000',
      agentPercentage: 30,
      clientPayoutAmount: '910000',
      productName: 'Payme — 1 ta',
      store: {
        name: 'Planet Phone',
      },
      agency: {
        name: 'Davlatbek',
      },
      agencyEmployee: {
        fullName: "Go'zal",
      },
    };

    const formatted = formatReceiptText(sampleOrder);

    const expected =
`Yangi chek #3531
⏳ Ombor statusi: Tasdiqlash kutilmoqda

🕐 Urilgan vaqt: 31.10.2026 20:43:54
👤 Savdochi: Исфандиёр Исроилов (2038308226)
📱 Ilova: Payme
💰 Limit: 1 300 000 so'm
📊 Foiz: 30%
💵 Hisoblangan summa: 910 000 so'm
📦 Mahsulotlar:
• Payme — 1 ta
🏪 Do'kon: Planet Phone
🤝 Agent: Davlatbek
👔 Agent xodimi: Go'zal
🆔 ad025e2d-8389-4724-939f-d9442ed3c6bc`;

    expect(formatted.trim()).toBe(expected.trim());
  });

  it('should correctly update ombor status when confirmed', () => {
    const confirmedOrder = {
      id: 'ad025e2d-8389-4724-939f-d9442ed3c6bc',
      checkNumber: 3531,
      omborStatus: 'Tasdiqlandi (Isfandiyor)',
      createdAt: new Date('2026-10-31T20:43:54+05:00'),
      seller: {
        firstName: 'Исфандиёр',
        lastName: 'Исроилов',
        telegramId: BigInt('2038308226'),
      },
      program: {
        name: 'Payme',
      },
      totalPrice: '1300000',
      agentPercentage: 30,
      clientPayoutAmount: '910000',
      productName: 'Payme — 1 ta',
      store: {
        name: 'Planet Phone',
      },
      agency: {
        name: 'Davlatbek',
      },
      agencyEmployee: {
        fullName: "Go'zal",
      },
    };

    const formatted = formatReceiptText(confirmedOrder);
    expect(formatted).toContain('✅ Ombor statusi: Tasdiqlandi (Isfandiyor)');
  });
});
