import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { UsersService } from '../modules/users/users.service';
import { OrdersService } from '../modules/orders/orders.service';
import { AssignmentsService } from '../modules/assignments/assignments.service';
import { DaftarService } from '../modules/daftar/daftar.service';
import { SalesService } from '../modules/sales/sales.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { DebtsService } from '../modules/debts/debts.service';
import { ReportsService } from '../modules/reports/reports.service';
import { AttachmentsService } from '../modules/attachments/attachments.service';
import { InventoryService } from '../modules/inventory/inventory.service';
import { OutboxService } from '../infrastructure/outbox/outbox.service';
import { getMainMenuKeyboard } from './keyboards/main-menu.keyboard';
import {
  BOT_TEXTS,
  MENU_BUTTONS,
  DAFTAR_STATUS_TEXTS,
  INVENTORY_STATUS_TEXTS,
  PAYMENT_STATUS_TEXTS,
} from '../common/constants';
import { FinancingProgramsService } from '../modules/financing-programs/financing-programs.service';
import { StoresService } from '../modules/stores/stores.service';
import { AgenciesService } from '../modules/agencies/agencies.service';
import { DecimalUtil } from '../common/decimal.util';
import { DateUtil } from '../common/date.util';
import { ExcelUtil } from '../common/excel.util';
import {
  RoleName,
  OrderStatus,
  DaftarStatus,
  InventoryUnitStatus,
  AttachmentType,
  PaymentMethod,
  Currency,
  PaymentStatus,
} from '@prisma/client';
import { Decimal } from 'decimal.js';

export function formatReceiptText(order: {
  checkNumber?: number | null;
  omborStatus?: string | null;
  createdAt: Date;
  seller: { firstName?: string | null; lastName?: string | null; telegramId?: bigint | number | string | null };
  program: { name: string };
  totalPrice: any;
  agentPercentage: any;
  clientPayoutAmount: any;
  productName?: string | null;
  store: { name: string };
  agency?: { name: string } | null;
  agencyEmployee?: { fullName: string } | null;
  id: string;
}): string {
  const checkNum = order.checkNumber ? `#${order.checkNumber}` : `#${order.id.slice(0, 6)}`;
  const omborStatus = order.omborStatus || 'Tasdiqlash kutilmoqda';
  const isConfirmed = omborStatus.includes('Tasdiqlandi');
  const isCancelled = omborStatus.includes('Bekor');
  const omborIcon = isConfirmed ? '✅' : (isCancelled ? '❌' : '⏳');

  const createdTime = DateUtil.formatTashkent(order.createdAt, 'DD.MM.YYYY HH:mm:ss');
  const sellerFullName = [order.seller.firstName, order.seller.lastName].filter(Boolean).join(' ') || 'Савдочи';
  const sellerTgId = order.seller.telegramId ? ` (${order.seller.telegramId})` : '';
  const ilova = order.program.name;
  const limitFormatted = DecimalUtil.formatMoney(order.totalPrice, "so'm");
  const foizVal = order.agentPercentage ? Number(order.agentPercentage).toString() : '0';
  const foizFormatted = `${foizVal}%`;
  const calculatedFormatted = DecimalUtil.formatMoney(order.clientPayoutAmount, "so'm");
  const products = order.productName || `${ilova} — 1 ta`;
  const productsFormatted = products.startsWith('•') ? products : `• ${products}`;
  const dokan = order.store.name;
  const agent = order.agency?.name || 'Agentsiz';
  const agentXodimi = order.agencyEmployee?.fullName || '—';
  const uuid = order.id;

  return `Yangi chek ${checkNum}
${omborIcon} Ombor statusi: ${omborStatus}

🕐 Urilgan vaqt: ${createdTime}
👤 Savdochi: ${sellerFullName}${sellerTgId}
📱 Ilova: ${ilova}
💰 Limit: ${limitFormatted}
📊 Foiz: ${foizFormatted}
💵 Hisoblangan summa: ${calculatedFormatted}
📦 Mahsulotlar:
${productsFormatted}
🏪 Do'kon: ${dokan}
🤝 Agent: ${agent}
👔 Agent xodimi: ${agentXodimi}
🆔 ${uuid}`;
}

export interface BotContext extends Context {
  user?: any;
  userRoles?: RoleName[];
}

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  public bot: Bot<BotContext>;
  private outboxInterval: any = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly assignmentsService: AssignmentsService,
    private readonly daftarService: DaftarService,
    private readonly salesService: SalesService,
    private readonly paymentsService: PaymentsService,
    private readonly debtsService: DebtsService,
    private readonly reportsService: ReportsService,
    private readonly attachmentsService: AttachmentsService,
    private readonly inventoryService: InventoryService,
    private readonly outboxService: OutboxService,
    private readonly programsService: FinancingProgramsService,
    private readonly storesService: StoresService,
    private readonly agenciesService: AgenciesService,
  ) {
    const token =
      process.env.BOT_TOKEN || '9167571167:AAG9nOKq8IoKV0h8wfl2xKSeXhoYYiwppz0';
    this.bot = new Bot<BotContext>(token);
  }

  async onModuleInit() {
    this.bot.catch((err) => {
      this.logger.error(`Telegram Bot Error: ${(err as any).message || err}`);
    });

    this.setupMiddlewares();
    this.setupHandlers();

    // Start outbox dispatcher
    this.outboxInterval = setInterval(() => {
      this.dispatchOutboxEvents().catch((err) => {
        this.logger.error(`Outbox dispatch error: ${err.message}`);
      });
    }, 3000);

    // Launch bot long polling if webhook is not set
    if (!process.env.WEBHOOK_URL) {
      this.bot.start({
        onStart: (info) => {
          this.logger.log(`Telegram Bot started successfully as @${info.username}`);
        },
      }).catch((err) => {
        this.logger.warn(`Telegram Bot polling warning: ${err.message}`);
      });
    }
  }

  async onModuleDestroy() {
    if (this.outboxInterval) {
      clearInterval(this.outboxInterval);
    }
    await this.bot.stop();
  }

  private setupMiddlewares() {
    // 1. Idempotency middleware: ProcessedTelegramUpdate deduplication (Section 11)
    this.bot.use(async (ctx, next) => {
      if (ctx.update?.update_id !== undefined) {
        const updateId = BigInt(ctx.update.update_id);
        try {
          const existing = await this.prisma.processedTelegramUpdate.findUnique({
            where: { updateId },
          });
          if (existing) {
            this.logger.debug(`Duplicate update received and skipped: ${updateId}`);
            return;
          }
          await this.prisma.processedTelegramUpdate.create({
            data: { updateId },
          });
        } catch (e) {
          // If collision or unique constraint, skip
          return;
        }
      }
      return next();
    });

    // 2. Authentication & Approval middleware (Section 3)
    this.bot.use(async (ctx, next) => {
      // In groups/supergroups, avoid blocking and auto-detect group ID
      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        try {
          const current = await this.prisma.systemSetting.findUnique({
            where: { key: 'RECEIPTS_GROUP_ID' },
          });
          if (!current) {
            await this.prisma.systemSetting.upsert({
              where: { key: 'RECEIPTS_GROUP_ID' },
              update: { value: ctx.chat.id.toString(), description: ctx.chat.title || 'Чеклар гуруҳи' },
              create: { key: 'RECEIPTS_GROUP_ID', value: ctx.chat.id.toString(), description: ctx.chat.title || 'Чеклар гуруҳи' },
            });
            this.logger.log(`Receipts group auto-registered: ${ctx.chat.id} (${ctx.chat.title})`);
          }
        } catch {}
        return next();
      }

      if (!ctx.from) return next();

      try {
        const user = await this.usersService.findOrCreateTelegramUser(ctx.from);
        ctx.user = user;
        ctx.userRoles = user.roles.map((r: any) => r.role.name as RoleName);

        if (!user.isApproved) {
          await ctx.reply(
            `${BOT_TEXTS.unauthorized}<code>${ctx.from.id}</code>\n\nАдминистратор тасдиқлагандан сўнг тизимдан тўлиқ фойдалана оласиз.`,
            { parse_mode: 'HTML' },
          );
          return;
        }
      } catch (err) {
        this.logger.error(`Auth middleware error: ${(err as Error).message}`);
      }

      return next();
    });
  }

  private setupHandlers() {
    // /start command
    this.bot.command('start', async (ctx) => {
      if (!ctx.user) {
        await ctx.reply(
          `${BOT_TEXTS.welcome}\n\nТизим ишга тушмоқда. Илтимос, бир неча сониядан сўнг қайта /start юборинг.`,
        );
        return;
      }
      const roles: RoleName[] = ctx.userRoles || [];
      const kb = getMainMenuKeyboard(roles);
      const name = [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(' ') || ctx.from?.first_name || 'Ходим';
      await ctx.reply(
        `${BOT_TEXTS.welcome}\n\nСизнинг профилингиз: <b>${name}</b>\nРоллар: <i>${roles.join(', ') || 'Ходим'}</i>`,
        { reply_markup: kb, parse_mode: 'HTML' },
      );
    });

    // Main menu buttons routing
    this.bot.hears([MENU_BUTTONS.newOrder, '➕ Янги буюртма', '🧾 Янги чек уриш', 'Янги чек'], async (ctx) => {
      await this.handleNewOrderButton(ctx);
    });

    this.bot.command(['check', 'new_order', 'yangi_chek'], async (ctx) => {
      await this.handleNewOrderButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.drafts, async (ctx) => {
      await this.handleDraftsButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.myOrders, async (ctx) => {
      await this.handleMyOrdersButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.incomingQueue, async (ctx) => {
      await this.handleIncomingQueueButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.daftarReview, async (ctx) => {
      await this.handleDaftarReviewButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.debts, async (ctx) => {
      await this.handleDebtsButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.inventory, async (ctx) => {
      await ctx.reply('📦 Товарларни қидириш учун IMEI ёки штрихкодни юборинг:');
    });

    this.bot.hears(MENU_BUTTONS.search, async (ctx) => {
      await ctx.reply('🔎 Қидириш учун Буюртма ID (ORD-2026-...) ёки Чек рақамини (PAY-2026-...) ёзинг:');
    });

    this.bot.hears(MENU_BUTTONS.reports, async (ctx) => {
      await this.handleReportsButton(ctx);
    });

    this.bot.hears(MENU_BUTTONS.management, async (ctx) => {
      await this.handleManagementButton(ctx);
    });

    // 📸 Photo messages handler (Points 9, 10)
    this.bot.on('message:photo', async (ctx) => {
      if (!ctx.user) return;
      const draft = await this.ordersService.getDraft(ctx.user.id);
      if (!draft) return;
      const d = (draft.formData as any) || {};

      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const fileId = largest.file_id;

      if (draft.step === 'WZ_9_CONTRACT_SCREEN') {
        const updated = { ...d, contractPhoto: fileId };
        await this.ordersService.saveDraft(ctx.user.id, 'WZ_10_PASSPORT_PHOTO', updated);
        await this.renderWzStep10PassportPhoto(ctx, updated);
        return;
      }

      if (draft.step === 'WZ_10_PASSPORT_PHOTO') {
        const updated = { ...d, passportPhoto: fileId };
        await this.ordersService.saveDraft(ctx.user.id, 'WZ_11_STORE', updated);
        await this.renderWzStep11Store(ctx, updated);
        return;
      }
    });

    // 📹 Video messages handler (Point 33)
    this.bot.on(['message:video_note', 'message:video'], async (ctx) => {
      if (!ctx.user) return;
      const draft = await this.ordersService.getDraft(ctx.user.id);
      if (!draft) return;
      const d = (draft.formData as any) || {};

      const fileId = ctx.message.video_note?.file_id || ctx.message.video?.file_id;
      if (draft.step === 'WZ2_33_VIDEO_NOTE' && fileId) {
        const updated = { ...d, videoFileId: fileId };
        await this.ordersService.saveDraft(ctx.user.id, 'WZ2_34_PAYMENT_STATUS', updated);
        await this.renderWz2Step34PaymentStatus(ctx, updated);
        return;
      }
    });

    // Callback query handling
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      await ctx.answerCallbackQuery();

      try {
        if (data.startsWith('accept_order:')) {
          const orderId = data.split(':')[1];
          await this.assignmentsService.acceptAssignment(orderId, ctx.user.id);
          await ctx.reply(`✅ Буюртма муваффақиятли қабул қилинди! Энди сиз ушбу буюртма бўйича 21–36-бандларни тўлдиришингиз ва савдоларни амалга оширишингиз мумкин.`);
        } else if (data.startsWith('handoff_order:')) {
          const orderId = data.split(':')[1];
          await this.showHandoffOperators(ctx, orderId);
        } else if (data.startsWith('assign_to:')) {
          const [, orderId, operatorId] = data.split(':');
          await this.assignmentsService.assignOrder(orderId, operatorId, ctx.user.id);
          await ctx.reply('✅ Буюртма иккинчи босқич ходимига муваффақиятли юборилди!');
        } else if (data.startsWith('review_daftar:')) {
          const [, orderId, statusStr] = data.split(':');
          const status = statusStr as DaftarStatus;
          if (status === DaftarStatus.NEEDS_CORRECTION) {
            await ctx.reply(`⚠️ Буюртмани қайтариш учун сабабни қуйидаги форматда ёзинг:\n<code>/reject_daftar ${orderId} [сабаб]</code>`, { parse_mode: 'HTML' });
          } else {
            await this.daftarService.updateReviewStatus({
              orderId,
              reviewerId: ctx.user.id,
              status,
            });
            await ctx.reply(`✅ Дафтар тасдиғи «${DAFTAR_STATUS_TEXTS[status]}» ҳолатига ўтказилди!`);
          }
        // ===================== STAGE 1 CALLBACKS (1–20) =====================
        } else if (data.startsWith('wz_prog:') || data.startsWith('chk_prog:') || data.startsWith('select_prog:')) {
          const programId = data.replace('wz_prog:', '').replace('chk_prog:', '').replace('select_prog:', '');
          const program = await this.programsService.getById(programId);
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = {
            ...cur,
            programId: program.id,
            programName: program.name,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_4_DURATION', updated);
          await this.renderWzStep4Duration(ctx, updated);
        } else if (data.startsWith('wz_dur:')) {
          const months = parseInt(data.split(':')[1], 10) || 12;
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};
          const endDate = new Date(Date.now() + months * 30 * 24 * 3600 * 1000);

          const updated = {
            ...cur,
            durationMonths: months,
            contractEndDate: endDate.toISOString(),
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_5_DAFTAR', updated);
          await this.renderWzStep5Daftar(ctx, updated);
        } else if (data.startsWith('wz_daftar:')) {
          const val = data.split(':')[1];
          const isYes = val === 'yes';
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = {
            ...cur,
            daftarRejected: isYes,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_6_CUSTOMER_NAME', updated);
          await this.renderWzStep6CustomerName(ctx, updated);
        } else if (data === 'wz_cname:self') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};
          const sellerName = [ctx.user?.firstName, ctx.user?.lastName].filter(Boolean).join(' ') || ctx.from?.first_name || 'Мижоз';

          const updated = {
            ...cur,
            customerName: sellerName,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_7_CUSTOMER_PHONE1', updated);
          await this.renderWzStep7CustomerPhone1(ctx, updated);
        } else if (data === 'wz_cphone1:self') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};
          const sellerPhone = ctx.user?.phone || `+998${ctx.user?.telegramId?.toString().slice(-9) || '901234567'}`;

          const updated = {
            ...cur,
            phone1: sellerPhone,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_8_CUSTOMER_PHONE2', updated);
          await this.renderWzStep8CustomerPhone2(ctx, updated);
        } else if (data === 'wz_cphone2:skip') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = {
            ...cur,
            phone2: null,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_9_CONTRACT_SCREEN', updated);
          await this.renderWzStep9ContractScreen(ctx, updated);
        } else if (data === 'wz_contract:skip') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = {
            ...cur,
            contractPhoto: null,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_10_PASSPORT_PHOTO', updated);
          await this.renderWzStep10PassportPhoto(ctx, updated);
        } else if (data === 'wz_passport:skip') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = {
            ...cur,
            passportPhoto: null,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_11_STORE', updated);
          await this.renderWzStep11Store(ctx, updated);
        } else if (data.startsWith('wz_store:') || data.startsWith('chk_store:')) {
          const storeId = data.replace('wz_store:', '').replace('chk_store:', '');
          const store = await this.storesService.getById(storeId);
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = {
            ...cur,
            storeId: store.id,
            storeName: store.name,
            storeAddress: store.address,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_12_GENERAL_LIMIT', updated);
          await this.renderWzStep12GeneralLimit(ctx, updated);
        } else if (data.startsWith('wz_genlim:')) {
          const amtStr = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (amtStr === 'custom') {
            await ctx.reply('✏️ <b>Клиент умумий лимитини ёзиб юборинг:</b>\nМисол: <code>2000000</code>', { parse_mode: 'HTML' });
            return;
          }

          const generalLimit = parseInt(amtStr, 10);
          const updated = { ...cur, generalLimit };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_13_WITHDRAW_LIMIT', updated);
          await this.renderWzStep13WithdrawableLimit(ctx, updated);
        } else if (data.startsWith('wz_withlim:')) {
          const amtStr = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          let withdrawableLimit = cur.generalLimit || 1300000;
          if (amtStr === 'custom') {
            await ctx.reply('✏️ <b>Ечиладиган лимит суммасини ёзиб юборинг:</b>\nМисол: <code>1300000</code>', { parse_mode: 'HTML' });
            return;
          } else if (amtStr !== 'full') {
            withdrawableLimit = parseInt(amtStr, 10);
          }

          const updated = { ...cur, withdrawableLimit };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_14_PRODUCT_PRICE', updated);
          await this.renderWzStep14ProductPrice(ctx, updated);
        } else if (data.startsWith('wz_price:')) {
          const amtStr = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (amtStr === 'custom') {
            await ctx.reply('✏️ <b>Маҳсулот прайс нархини ёзиб юборинг:</b>\nМисол: <code>1300000</code>', { parse_mode: 'HTML' });
            return;
          }

          const productPrice = cur.withdrawableLimit || 1300000;
          const updated = { ...cur, productPrice };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_15_PERCENTAGE', updated);
          await this.renderWzStep15Percentage(ctx, updated);
        } else if (data.startsWith('wz_pct:') || data.startsWith('chk_pct:')) {
          const pctStr = data.replace('wz_pct:', '').replace('chk_pct:', '');
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (pctStr === 'custom') {
            await ctx.reply('✏️ <b>Агент фоизини рақамда ёзинг:</b>\nМисол: <b>25</b> ёки <b>30</b>', { parse_mode: 'HTML' });
            return;
          }

          const foiz = parseInt(pctStr, 10);
          const withdrawableLimit = cur.withdrawableLimit || cur.generalLimit || 1300000;
          const fee = (withdrawableLimit * foiz) / 100;
          const clientPayoutAmount = Math.round(withdrawableLimit - fee);

          const updated = {
            ...cur,
            foiz,
            clientPayoutAmount,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_17_PRODUCT_NAME', updated);
          await this.renderWzStep17ProductName(ctx, updated);
        } else if (data.startsWith('wz_prod:')) {
          const prodType = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (prodType === 'custom') {
            await ctx.reply('✏️ <b>Маҳсулот номини ёзиб юборинг:</b>\nМисол: <code>iPhone 15 Pro — 1 ta</code>', { parse_mode: 'HTML' });
            return;
          }

          let prodName = `${cur.programName} — 1 ta`;
          if (prodType === 'ip15p') prodName = 'iPhone 15 Pro — 1 ta';
          else if (prodType === 'ip14') prodName = 'iPhone 14 — 1 ta';
          else if (prodType === 's24') prodName = 'Samsung Galaxy S24 — 1 ta';

          const updated = { ...cur, productName: prodName };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_18_IMEI_BARCODE', updated);
          await this.renderWzStep18ImeiBarcode(ctx, updated);
        } else if (data === 'wz_imei:skip') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = { ...cur, imeiOrBarcode: null };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_19_QUANTITY', updated);
          await this.renderWzStep19Quantity(ctx, updated);
        } else if (data.startsWith('wz_qty:')) {
          const numStr = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (numStr === 'custom') {
            await ctx.reply('✏️ <b>Умумий маҳсулот сонини рақамда ёзинг:</b>\nМисол: <b>2</b> ёки <b>5</b>', { parse_mode: 'HTML' });
            return;
          }

          const quantity = parseInt(numStr, 10) || 1;
          const updated = { ...cur, quantity };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_20_DAFTAR_STATUS', updated);
          await this.renderWzStep20DaftarStatus(ctx, updated);
        } else if (data.startsWith('wz_daft_stat:')) {
          const status = data.split(':')[1] as DaftarStatus;
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = { ...cur, daftarStatus: status };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ_STAGE1_PREVIEW', updated);
          await this.renderWzStage1Preview(ctx, updated);
        } else if (data === 'wz_submit_confirm' || data === 'chk_confirm') {
          await this.submitStage1Order36(ctx);
        } else if (data === 'wz_cancel' || data === 'chk_cancel') {
          await this.ordersService.clearDraft(ctx.user.id);
          await this.safeEditOrReply(ctx, '❌ Бекор қилинди.');

        // ===================== STAGE 2 CALLBACKS (21–34) =====================
        } else if (data.startsWith('wz2_start:')) {
          const orderId = data.split(':')[1];
          await this.startStage2Wizard(ctx, orderId);
        } else if (data.startsWith('wz2_stat:')) {
          const status = data.split(':')[1] as InventoryUnitStatus;
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = { ...cur, inventoryStatus: status };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_22_AGENCY', updated);
          await this.renderWz2Step22Agency(ctx, updated);
        } else if (data.startsWith('wz2_ag:')) {
          const agencyId = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          let agName = 'Agentsiz';
          let agId: string | null = null;
          if (agencyId !== 'none') {
            const ag = await this.agenciesService.getById(agencyId);
            agName = ag.name;
            agId = ag.id;
          }

          const updated = { ...cur, agencyId: agId, agencyName: agName };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_23_AGENCY_EMPLOYEE', updated);
          await this.renderWz2Step23AgencyEmployee(ctx, updated);
        } else if (data.startsWith('wz2_emp:')) {
          const empId = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          let empName = '—';
          let employeeId: string | null = null;
          if (empId !== 'none' && cur.agencyId) {
            const emps = await this.agenciesService.getEmployeesByAgency(cur.agencyId);
            const found = emps.find((e) => e.id === empId);
            if (found) {
              empName = found.fullName;
              employeeId = found.id;
            }
          }

          const updated = { ...cur, agencyEmployeeId: employeeId, agencyEmployeeName: empName };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_24_BUYER_ADDR', updated);
          await this.renderWz2Step24BuyerAddress(ctx, updated);
        } else if (data.startsWith('wz2_addr:')) {
          const addrType = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (addrType === 'custom') {
            await ctx.reply('✏️ <b>Харидор манзили ва дўкон рақамини ёзиб юборинг:</b>\nМисол: <code>Малика бозори, 42-дўкон</code>', { parse_mode: 'HTML' });
            return;
          }

          let buyerAddress = 'Малика бозори, 15-дўкон';
          if (addrType === 'abusaxiy') buyerAddress = 'Абу Сахий, 120-дўкон';

          const updated = { ...cur, buyerAddress };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_25_BUYER_NAME', updated);
          await ctx.reply(
            `👤 <b>25-банд: Техникани харид қилувчининг Исми:</b>\n\n` +
            `<i>(Харидорнинг исм-фамилиясини ёзиб юборинг):</i>`,
            { parse_mode: 'HTML' },
          );
        } else if (data.startsWith('wz2_planned:')) {
          const type = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (type === 'custom') {
            await ctx.reply('✏️ <b>Техниканинг сотилиш (режавий) нархини ёзиб юборинг:</b>\nМисол: <code>1500000</code>', { parse_mode: 'HTML' });
            return;
          }

          const plannedPrice = cur.orderPrice || 1300000;
          const updated = { ...cur, plannedSalePrice: plannedPrice };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_28_ACTUAL_PRICE', updated);
          await this.renderWz2Step28ActualPrice(ctx, updated);
        } else if (data.startsWith('wz2_actual:')) {
          const type = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (type === 'custom') {
            await ctx.reply('✏️ <b>Техниканинг сотилган (ҳақиқий) нархини ёзиб юборинг:</b>\nМисол: <code>1500000</code>', { parse_mode: 'HTML' });
            return;
          }

          const actualPrice = cur.plannedSalePrice || cur.orderPrice || 1300000;
          const updated = { ...cur, actualSalePrice: actualPrice };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_29_PAYMENT_METHOD', updated);
          await this.renderWz2Step29PaymentMethod(ctx, updated);
        } else if (data.startsWith('wz2_paymeth:')) {
          const methodStr = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = { ...cur, paymentMethod: methodStr };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_29_PAY_AMOUNT', updated);
          await this.renderWz2Step29PaymentAmount(ctx, updated);
        } else if (data.startsWith('wz2_payamt:')) {
          const type = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          let paidAmount = 0;
          if (type === 'full') {
            paidAmount = cur.actualSalePrice || 1300000;
          } else if (type === 'custom') {
            await ctx.reply('✏️ <b>Тўланган суммани ёзиб юборинг:</b>\nМисол: <code>1000000</code>', { parse_mode: 'HTML' });
            return;
          }

          const actual = cur.actualSalePrice || 1300000;
          const diff = Math.max(0, actual - paidAmount);
          const hasDebt = diff > 0;

          const updated = {
            ...cur,
            paidAmount,
            remainingAmount: diff,
            hasDebt,
          };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_30_HAS_DEBT', updated);
          await this.renderWz2Step30HasDebt(ctx, updated);
        } else if (data.startsWith('wz2_hasdebt:')) {
          const val = data.split(':')[1];
          const hasDebt = val === 'yes';
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (!hasDebt) {
            const updated = {
              ...cur,
              hasDebt: false,
              remainingAmount: 0,
              debtDueDate: null,
            };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_33_VIDEO_NOTE', updated);
            await this.renderWz2Step33VideoNote(ctx, updated);
          } else {
            const updated = { ...cur, hasDebt: true };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_31_REM_AMOUNT', updated);
            await this.renderWz2Step31RemainingAmount(ctx, updated);
          }
        } else if (data.startsWith('wz2_remamt:')) {
          const type = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (type === 'custom') {
            await ctx.reply('✏️ <b>Қолдиқ қарз суммасини ёзиб юборинг:</b>\nМисол: <code>300000</code>', { parse_mode: 'HTML' });
            return;
          }

          const rem = cur.remainingAmount !== undefined ? cur.remainingAmount : Math.max(0, (cur.actualSalePrice || 0) - (cur.paidAmount || 0));
          const updated = { ...cur, remainingAmount: rem };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_32_DUE_DATE', updated);
          await this.renderWz2Step32DueDate(ctx, updated);
        } else if (data.startsWith('wz2_duedate:')) {
          const daysStr = data.split(':')[1];
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (daysStr === 'custom') {
            await ctx.reply('✏️ <b>Тўлов муддатини қуйидаги форматда ёзинг:</b>\n<code>КК.ОО.ЙЙЙЙ</code> (мисол: <code>15.11.2026</code>)', { parse_mode: 'HTML' });
            return;
          }

          const days = parseInt(daysStr, 10) || 7;
          const dueDate = new Date(Date.now() + days * 24 * 3600 * 1000);
          const updated = { ...cur, debtDueDate: dueDate.toISOString() };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_33_VIDEO_NOTE', updated);
          await this.renderWz2Step33VideoNote(ctx, updated);
        } else if (data === 'wz2_video:skip') {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = { ...cur, videoFileId: null };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_34_PAYMENT_STATUS', updated);
          await this.renderWz2Step34PaymentStatus(ctx, updated);
        } else if (data.startsWith('wz2_paystat:')) {
          const stat = data.split(':')[1] as PaymentStatus;
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          const updated = { ...cur, paymentStatus: stat };
          await this.ordersService.saveDraft(ctx.user.id, 'WZ2_PREVIEW', updated);
          await this.renderWz2Preview(ctx, updated);
        } else if (data === 'wz2_confirm') {
          await this.submitStage2Sale36(ctx);

        // ===================== POINTS 35 & 36 DEBT CALLBACKS =====================
        } else if (data.startsWith('debt_pay_start:')) {
          const saleId = data.split(':')[1];
          await this.renderDebtPaymentMethods(ctx, saleId);
        } else if (data.startsWith('debt_meth:')) {
          const [, saleId, method] = data.split(':');
          await this.renderDebtAmountPrompt(ctx, saleId, method);
        } else if (data.startsWith('debt_amt:')) {
          const [, saleId, type] = data.split(':');
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const cur = (draft?.formData as any) || {};

          if (type === 'custom') {
            await ctx.reply('✏️ <b>Қабул қилинадиган тўлов суммасини ёзиб юборинг:</b>\nМисол: <code>200000</code>', { parse_mode: 'HTML' });
            return;
          }

          const remAmt = cur.remainingAmount || 0;
          await this.executeDebtPayment(ctx, saleId, cur.methodStr || 'CASH', remAmt);
        } else if (data === 'export_my_orders_excel') {
          await this.handleExportOrdersExcel(ctx);
        } else if (data.startsWith('ombor_confirm:')) {
          const orderId = data.split(':')[1];
          const actorName = ctx.from?.first_name || 'Омборчи';

          try {
            const updated = await this.ordersService.confirmOmborStatus(orderId, actorName);
            const updatedText = formatReceiptText(updated as any);

            try {
              await ctx.editMessageText(updatedText, {
                reply_markup: new InlineKeyboard().text(`✅ Омбор: Тасдиқланди (${actorName})`, 'noop'),
              });
            } catch {}

            await ctx.answerCallbackQuery({
              text: '✅ Омбор томонидан муваффақиятли тасдиқланди!',
              show_alert: true,
            });

            if (updated.seller?.telegramId) {
              await this.bot.api.sendMessage(
                updated.seller.telegramId.toString(),
                `✅ <b>Сизнинг #${updated.checkNumber} рақамли чекингиз омбор томонидан тасдиқланди!</b>\n\n<code>${updatedText}</code>`,
                { parse_mode: 'HTML' },
              ).catch(() => {});
            }
          } catch (err) {
            await ctx.answerCallbackQuery({
              text: `❌ Хатолик: ${(err as Error).message}`,
              show_alert: true,
            });
          }
        } else if (data.startsWith('ombor_cancel:')) {
          const orderId = data.split(':')[1];
          const actorName = ctx.from?.first_name || 'Ходим';

          try {
            const updated = await this.ordersService.cancelOrder(orderId, actorName);
            const updatedText = formatReceiptText(updated as any);

            try {
              await ctx.editMessageText(updatedText, {
                reply_markup: new InlineKeyboard().text(`❌ Омбор: Бекор қилинди (${actorName})`, 'noop'),
              });
            } catch {}

            await ctx.answerCallbackQuery({
              text: '❌ Чек омбор томонидан бекор қилинди!',
              show_alert: true,
            });

            if (updated.seller?.telegramId) {
              await this.bot.api.sendMessage(
                updated.seller.telegramId.toString(),
                `❌ <b>Сизнинг #${updated.checkNumber} рақамли чекингиз бекор қилинди!</b>\n\n<code>${updatedText}</code>`,
                { parse_mode: 'HTML' },
              ).catch(() => {});
            }
          } catch (err) {
            await ctx.answerCallbackQuery({
              text: `❌ Хатолик: ${(err as Error).message}`,
              show_alert: true,
            });
          }
        } else if (data.startsWith('discard_draft:')) {
          await this.ordersService.clearDraft(ctx.user.id);
          await ctx.reply('🗑 Қоралама бекор қилинди.');
          await this.handleNewOrderButton(ctx);
        } else if (data.startsWith('resume_draft:')) {
          const draft = await this.ordersService.getDraft(ctx.user.id);
          await ctx.reply(`▶️ Қоралама давом эттирилмоқда (босқич: ${draft?.step}).`);
        } else if (data === 'mgmt_add_admin') {
          await ctx.reply(
            `➕ <b>Янги админ қўшиш:</b>\n\n` +
            `Админ қилмоқчи бўлган фойдаланувчининг Telegram ID рақамини қуйидаги форматда юборинг:\n\n` +
            `<code>/add_admin [TELEGRAM_ID]</code>\n\n` +
            `Мисол:\n` +
            `<code>/add_admin 7146730534</code>`,
            { parse_mode: 'HTML' },
          );
        } else if (data === 'mgmt_list_admins') {
          const admins = await this.usersService.listAdmins();
          let txt = `👑 <b>Тизимдаги фаол админлар (${admins.length} та):</b>\n\n`;
          for (const a of admins) {
            txt += `• <b>${a.firstName || ''} ${a.lastName || ''}</b> (@${a.username || 'username йўқ'})\n  ID: <code>${a.telegramId}</code>\n\n`;
          }
          await ctx.reply(txt, { parse_mode: 'HTML' });
        } else if (data === 'mgmt_pending') {
          const pending = await this.usersService.listPendingUsers();
          if (pending.length === 0) {
            await ctx.reply('✅ Ҳозирда тасдиқ кутилаётган фойдаланувчилар йўқ.');
            return;
          }
          let txt = `⏳ <b>Тасдиқ кутилаётган фойдаланувчилар (${pending.length} та):</b>\n\n`;
          for (const u of pending.slice(0, 5)) {
            txt += `• ${u.firstName || ''} ${u.lastName || ''} (@${u.username || '—'})\n  ID: <code>${u.telegramId}</code>\n  Тасдиқлаш: <code>/approve_user ${u.telegramId} SELLER</code>\n\n`;
          }
          await ctx.reply(txt, { parse_mode: 'HTML' });
        } else if (data === 'mgmt_list_staff') {
          const staff = await this.usersService.listStaffUsers();
          let txt = `👥 <b>Тизимдаги ходимлар (${staff.length} та):</b>\n\n`;
          for (const s of staff.slice(0, 10)) {
            const roleList = s.roles.map((r: any) => r.role.name).join(', ');
            txt += `• <b>${s.firstName || ''} ${s.lastName || ''}</b>\n  ID: <code>${s.telegramId}</code>\n  Роллар: <i>${roleList || 'Ходим'}</i>\n\n`;
          }
          await ctx.reply(txt, { parse_mode: 'HTML' });
        } else if (data === 'mgmt_receipts_group') {
          const setting = await this.prisma.systemSetting.findUnique({
            where: { key: 'RECEIPTS_GROUP_ID' },
          });
          const currentId = process.env.RECEIPTS_GROUP_ID || setting?.value;
          if (currentId) {
            await ctx.reply(
              `📢 <b>Уланган чеклар гуруҳи:</b>\n\n` +
              `• Гуруҳ ID: <code>${currentId}</code>\n` +
              `• Номи: <b>${setting?.description || 'Чеклар гуруҳи'}</b>\n\n` +
              `Янги гуруҳни улаш учун керакли гуруҳ ичида <code>/set_receipts_group</code> буйруғини юборинг.`,
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply(
              `📢 <b>Чеклар гуруҳи ҳали уланмаган!</b>\n\n` +
              `Гуруҳни улаш учун:\n` +
              `1. Ботни гуруҳга қўшинг ва админ қилинг.\n` +
              `2. Гуруҳ ичига <code>/set_receipts_group</code> буйруғини юборинг.\n` +
              `Бот автоматик тарзда барча чекларни шу гуруҳга юборишни бошлайди!`,
              { parse_mode: 'HTML' },
            );
          }
        } else if (data.startsWith('view_order:')) {
          const orderId = data.split(':')[1];
          await this.renderOrderCard(ctx, orderId);
        } else if (data.startsWith('view_passport:')) {
          const attachmentId = data.split(':')[1];
          const accessUrl = await this.attachmentsService.getAttachmentAccess(attachmentId, ctx.user.id);
          await ctx.reply(`🔒 Ҳимояланган паспорт файли ҳаволаси:\n${accessUrl}`);
        }
      } catch (err) {
        await ctx.reply(`❌ Хатолик: ${(err as Error).message}`);
      }
    });

    // Text messages for search and commands
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();

      // /group_id command to get group chatId
      if (text === '/group_id' || text === '/chat_id') {
        await ctx.reply(
          `🆔 <b>Ушбу чат маълумотлари:</b>\n` +
          `• Chat ID: <code>${ctx.chat?.id}</code>\n` +
          `• Номи: <b>${ctx.chat?.title || 'Шахсий чат'}</b>\n` +
          `• Тури: <i>${ctx.chat?.type}</i>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // /set_receipts_group command
      if (text.startsWith('/set_receipts_group')) {
        const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
        let targetGroupId: string | null = null;
        let groupTitle = ctx.chat?.title || 'Чеклар гуруҳи';

        if (isGroup) {
          targetGroupId = ctx.chat!.id.toString();
        } else {
          const arg = text.replace('/set_receipts_group', '').trim();
          if (arg) {
            targetGroupId = arg;
          }
        }

        if (!targetGroupId) {
          await ctx.reply(
            `Гуруҳни созлаш учун:\n1) Ушбу гуруҳнинг ичида <code>/set_receipts_group</code> ёзинг, ёки\n2) Шахсий чатда <code>/set_receipts_group [GROUP_CHAT_ID]</code> ёзинг.`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        await this.prisma.systemSetting.upsert({
          where: { key: 'RECEIPTS_GROUP_ID' },
          update: { value: targetGroupId, description: groupTitle },
          create: { key: 'RECEIPTS_GROUP_ID', value: targetGroupId, description: groupTitle },
        });

        await ctx.reply(
          `✅ <b>Чеклар гуруҳи муваффақиятли созланди!</b>\n\n` +
          `• Гуруҳ ID: <code>${targetGroupId}</code>\n` +
          `• Номи: <b>${groupTitle}</b>\n\n` +
          `Энди барча тўлов чеклари ва янги буюртмалар автоматик тарзда ушбу гуруҳга юборилади! 🧾`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // /add_admin command
      if (text.startsWith('/add_admin ')) {
        const isSuperAdmin = ctx.userRoles?.includes(RoleName.SUPER_ADMIN);
        if (!isSuperAdmin) {
          await ctx.reply(BOT_TEXTS.accessDenied);
          return;
        }

        const targetTgIdStr = text.replace('/add_admin ', '').trim();
        if (!/^\d+$/.test(targetTgIdStr)) {
          await ctx.reply('❌ Нотўғри Telegram ID. Фақат рақамлардан иборат бўлиши керак.\nМисол: <code>/add_admin 123456789</code>', { parse_mode: 'HTML' });
          return;
        }

        try {
          const targetUser = await this.usersService.addAdminByTelegramId(ctx.user.id, targetTgIdStr);
          await ctx.reply(
            `👑 <b>Янги админ муваффақиятли қўшилди!</b>\n\n` +
            `• Telegram ID: <code>${targetTgIdStr}</code>\n` +
            `• Исми: <b>${targetUser.firstName || 'Admin'}</b>\n` +
            `• Роли: <b>SUPER_ADMIN</b>\n` +
            `• Ҳолати: <b>Фаол (Approved)</b>\n\n` +
            `Ушбу фойдаланувчи энди ботга кириб /start босганда тўлиқ админ ҳуқуқларига эга бўлади.`,
            { parse_mode: 'HTML' },
          );
        } catch (err) {
          await ctx.reply(`❌ Хатолик: ${(err as Error).message}`);
        }
        return;
      }

      // /approve_user command
      if (text.startsWith('/approve_user ')) {
        const isSuperAdmin = ctx.userRoles?.includes(RoleName.SUPER_ADMIN);
        if (!isSuperAdmin) {
          await ctx.reply(BOT_TEXTS.accessDenied);
          return;
        }

        const parts = text.split(' ');
        const targetTgIdStr = parts[1];
        const rolesStr = parts[2] || 'SELLER';
        const roleNames = rolesStr.split(',') as RoleName[];

        try {
          const userRecord = await this.usersService.getUserByTelegramId(BigInt(targetTgIdStr));
          if (!userRecord) {
            await ctx.reply(`Фойдаланувчи топилмади: ${targetTgIdStr}`);
            return;
          }

          await this.usersService.approveUser(ctx.user.id, userRecord.id, roleNames);
          await ctx.reply(
            `✅ Фойдаланувчи тасдиқланди: <b>${userRecord.firstName || ''}</b> (ID: <code>${targetTgIdStr}</code>)\n` +
            `Берилган роллар: <i>${roleNames.join(', ')}</i>`,
            { parse_mode: 'HTML' },
          );
        } catch (err) {
          await ctx.reply(`❌ Хатолик: ${(err as Error).message}`);
        }
        return;
      }

      // Check active wizard draft inputs
      if (ctx.user) {
        const draft = await this.ordersService.getDraft(ctx.user.id);
        if (draft) {
          const d = (draft.formData as any) || {};

          // Stage 1 text inputs
          if (draft.step === 'WZ_6_CUSTOMER_NAME') {
            const updated = { ...d, customerName: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_7_CUSTOMER_PHONE1', updated);
            await this.renderWzStep7CustomerPhone1(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_7_CUSTOMER_PHONE1') {
            const updated = { ...d, phone1: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_8_CUSTOMER_PHONE2', updated);
            await this.renderWzStep8CustomerPhone2(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_8_CUSTOMER_PHONE2') {
            const updated = { ...d, phone2: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_9_CONTRACT_SCREEN', updated);
            await this.renderWzStep9ContractScreen(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_12_GENERAL_LIMIT') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean <= 0) {
              await ctx.reply('❌ Илтимос, суммани рақамда ёзинг (масалан: <code>2000000</code>):', { parse_mode: 'HTML' });
              return;
            }
            const updated = { ...d, generalLimit: clean };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_13_WITHDRAW_LIMIT', updated);
            await this.renderWzStep13WithdrawableLimit(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_13_WITHDRAW_LIMIT') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean <= 0) {
              await ctx.reply('❌ Илтимос, тўғри суммани ёзинг:', { parse_mode: 'HTML' });
              return;
            }
            if (d.generalLimit && clean > d.generalLimit) {
              await ctx.reply(`❌ Ечиладиган лимит (${DecimalUtil.formatMoney(clean)}) умумий лимитдан (${DecimalUtil.formatMoney(d.generalLimit)}) ошмаслиги керак! Қайта киритинг:`);
              return;
            }
            const updated = { ...d, withdrawableLimit: clean };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_14_PRODUCT_PRICE', updated);
            await this.renderWzStep14ProductPrice(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_14_PRODUCT_PRICE') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean <= 0) {
              await ctx.reply('❌ Илтимос, прайс нархини рақамда ёзинг:', { parse_mode: 'HTML' });
              return;
            }
            const updated = { ...d, productPrice: clean };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_15_PERCENTAGE', updated);
            await this.renderWzStep15Percentage(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_15_PERCENTAGE' || draft.step === 'INPUT_CUSTOM_PERCENTAGE') {
            const num = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(num) || num < 0 || num > 100) {
              await ctx.reply('❌ Илтимос, 0 дан 100 гача бўлган фоизни ёзинг (масалан: 25 ёки 30):');
              return;
            }
            const withdrawableLimit = d.withdrawableLimit || d.generalLimit || 1300000;
            const fee = (withdrawableLimit * num) / 100;
            const clientPayoutAmount = Math.round(withdrawableLimit - fee);

            const updated = {
              ...d,
              foiz: num,
              clientPayoutAmount,
            };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_17_PRODUCT_NAME', updated);
            await this.renderWzStep17ProductName(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_17_PRODUCT_NAME' || draft.step === 'INPUT_CUSTOM_PRODUCT') {
            const updated = { ...d, productName: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_18_IMEI_BARCODE', updated);
            await this.renderWzStep18ImeiBarcode(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_18_IMEI_BARCODE') {
            const updated = { ...d, imeiOrBarcode: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_19_QUANTITY', updated);
            await this.renderWzStep19Quantity(ctx, updated);
            return;
          }

          if (draft.step === 'WZ_19_QUANTITY') {
            const qty = parseInt(text.replace(/[^\d]/g, ''), 10) || 1;
            const updated = { ...d, quantity: qty };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ_20_DAFTAR_STATUS', updated);
            await this.renderWzStep20DaftarStatus(ctx, updated);
            return;
          }

          // Stage 2 text inputs
          if (draft.step === 'WZ2_24_BUYER_ADDR') {
            const updated = { ...d, buyerAddress: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_25_BUYER_NAME', updated);
            await ctx.reply('👤 <b>25-банд: Техникани харид қилувчининг Исми:</b>\n\n(Исм-фамилияни ёзинг):', { parse_mode: 'HTML' });
            return;
          }

          if (draft.step === 'WZ2_25_BUYER_NAME') {
            const updated = { ...d, buyerName: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_26_BUYER_PHONE', updated);
            await ctx.reply('📞 <b>26-банд: Техникани харид қилувчининг телефон рақами:</b>\n\n(Мисол: <code>+998901234567</code>):', { parse_mode: 'HTML' });
            return;
          }

          if (draft.step === 'WZ2_26_BUYER_PHONE') {
            const updated = { ...d, buyerPhone: text };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_27_PLANNED_PRICE', updated);
            await this.renderWz2Step27PlannedPrice(ctx, updated);
            return;
          }

          if (draft.step === 'WZ2_27_PLANNED_PRICE') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean <= 0) {
              await ctx.reply('❌ Илтимос, тўғри режавий нархни ёзинг:', { parse_mode: 'HTML' });
              return;
            }
            const updated = { ...d, plannedSalePrice: clean };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_28_ACTUAL_PRICE', updated);
            await this.renderWz2Step28ActualPrice(ctx, updated);
            return;
          }

          if (draft.step === 'WZ2_28_ACTUAL_PRICE') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean <= 0) {
              await ctx.reply('❌ Илтимос, ҳақиқий сотилган нархни ёзинг:', { parse_mode: 'HTML' });
              return;
            }
            const updated = { ...d, actualSalePrice: clean };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_29_PAYMENT_METHOD', updated);
            await this.renderWz2Step29PaymentMethod(ctx, updated);
            return;
          }

          if (draft.step === 'WZ2_29_PAY_AMOUNT') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean < 0) {
              await ctx.reply('❌ Илтимос, тўланган суммани ёзинг:', { parse_mode: 'HTML' });
              return;
            }
            const actual = d.actualSalePrice || 1300000;
            const diff = Math.max(0, actual - clean);
            const hasDebt = diff > 0;
            const updated = { ...d, paidAmount: clean, remainingAmount: diff, hasDebt };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_30_HAS_DEBT', updated);
            await this.renderWz2Step30HasDebt(ctx, updated);
            return;
          }

          if (draft.step === 'WZ2_31_REM_AMOUNT') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean < 0) {
              await ctx.reply('❌ Илтимос, қолдиқ қарз суммасини ёзинг:', { parse_mode: 'HTML' });
              return;
            }
            const updated = { ...d, remainingAmount: clean };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_32_DUE_DATE', updated);
            await this.renderWz2Step32DueDate(ctx, updated);
            return;
          }

          if (draft.step === 'WZ2_32_DUE_DATE') {
            const parsed = DateUtil.parseToUtcDate(text);
            const dueDate = parsed || new Date(Date.now() + 7 * 24 * 3600 * 1000);
            const updated = { ...d, debtDueDate: dueDate.toISOString() };
            await this.ordersService.saveDraft(ctx.user.id, 'WZ2_33_VIDEO_NOTE', updated);
            await this.renderWz2Step33VideoNote(ctx, updated);
            return;
          }

          if (draft.step === 'DEBT_INPUT_AMOUNT') {
            const clean = parseInt(text.replace(/[^\d]/g, ''), 10);
            if (isNaN(clean) || clean <= 0) {
              await ctx.reply('❌ Илтимос, суммани рақамда киритинг:', { parse_mode: 'HTML' });
              return;
            }
            await this.executeDebtPayment(ctx, d.saleId, d.methodStr || 'CASH', clean);
            return;
          }
        }
      }

      // /client command to save customer info into draft
      if (text.startsWith('/client ')) {
        const parts = text.replace('/client ', '').trim().split(' ');
        if (parts.length < 5) {
          await ctx.reply(
            `❌ Нотўғри формат!\nИлтимос, қуйидаги форматда киритинг:\n<code>/client ФИШ Тел УмумийЛимит ЕчиладиганЛимит Сана</code>\n\nМисол:\n<code>/client Алишер Каримов +998901234567 15000000 12000000 31.12.2026</code>`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        const dateStr = parts[parts.length - 1];
        const withdrawableLimit = parts[parts.length - 2];
        const generalLimit = parts[parts.length - 3];
        const phone = parts[parts.length - 4];
        const fullName = parts.slice(0, parts.length - 4).join(' ');

        if (Number(withdrawableLimit) > Number(generalLimit)) {
          await ctx.reply(
            `❌ <b>Лимит хатоси:</b> Ечиладиган лимит (${withdrawableLimit}) умумий лимитдан (${generalLimit}) ошиб кетиши мумкин эмас!`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        const draft = await this.ordersService.getDraft(ctx.user.id);
        const currentData = (draft?.formData as any) || {};
        await this.ordersService.saveDraft(ctx.user.id, 'INPUT_ITEMS', {
          ...currentData,
          customer: {
            fullName,
            phone1: phone,
            generalLimit,
            withdrawableLimit,
          },
          contractEndDate: dateStr,
          items: currentData.items || [],
        });

        await ctx.reply(
          `✅ <b>Мижоз қабул қилинди:</b>\n` +
          `• Ф.И.Ш: <b>${fullName}</b>\n` +
          `• Тел: ${phone}\n` +
          `• Умумий лимит: ${DecimalUtil.formatMoney(generalLimit)}\n` +
          `• Ечиладиган лимит: ${DecimalUtil.formatMoney(withdrawableLimit)}\n` +
          `• Шартнома тугаш санаси: ${dateStr}\n\n` +
          `<b>4-босқич: Товар қўшиш:</b>\n` +
          `Қуйидаги форматда маҳсулотни киритинг:\n` +
          `<code>/item [Категория] [Бренд] [Модель] [Миқдори] [Бирлик нархи]</code>\n\n` +
          `Мисол:\n` +
          `<code>/item Смартфон Apple iPhone_15_Pro 1 12000000</code>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // /item command to add items
      if (text.startsWith('/item ')) {
        const parts = text.replace('/item ', '').trim().split(' ');
        if (parts.length < 5) {
          await ctx.reply(
            `❌ Нотўғри формат!\nМисол: <code>/item Смартфон Apple iPhone_15_Pro 1 12000000</code>`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        const unitPrice = parts[parts.length - 1];
        const quantity = parseInt(parts[parts.length - 2], 10);
        const model = parts[parts.length - 3].replace(/_/g, ' ');
        const brand = parts[parts.length - 4];
        const category = parts.slice(0, parts.length - 4).join(' ');

        const draft = await this.ordersService.getDraft(ctx.user.id);
        const currentData = (draft?.formData as any) || {};
        const items = currentData.items || [];

        items.push({
          category,
          brand,
          model,
          quantity,
          unitPrice,
        });

        await this.ordersService.saveDraft(ctx.user.id, 'INPUT_ITEMS', {
          ...currentData,
          items,
        });

        let total = new Decimal(0);
        let itemsSummary = '';
        items.forEach((it: any, idx: number) => {
          const itemTotal = DecimalUtil.mul(it.unitPrice, it.quantity);
          total = total.plus(itemTotal);
          itemsSummary += `${idx + 1}. ${it.brand} ${it.model} (${it.quantity} та x ${DecimalUtil.formatMoney(it.unitPrice)}) = ${DecimalUtil.formatMoney(itemTotal)}\n`;
        });

        await ctx.reply(
          `✅ <b>Товар қўшилди!</b>\n\n` +
          `<b>Буюртмадаги товарлар:</b>\n${itemsSummary}\n` +
          `<b>Жами сумма:</b> <b>${DecimalUtil.formatMoney(total)}</b>\n\n` +
          `• Яна товар қўшиш учун яна <code>/item ...</code> юборинг.\n` +
          `• Буюртмани расмийлаштириш учун: <code>/submit_order</code> буйруғини юборинг!`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // /submit_order command
      if (text === '/submit_order') {
        const draft = await this.ordersService.getDraft(ctx.user.id);
        const currentData = (draft?.formData as any) || {};

        if (!currentData.programId || !currentData.storeId || !currentData.customer || !currentData.items?.length) {
          await ctx.reply('❌ Буюртма маълумотлари тўлиқ эмас. Илтимос, аввал дастур, дўкон, мижоз ва товарни киритинг.');
          return;
        }

        try {
          // Attach default contract and passport attachments
          const contractAtt = await this.prisma.attachment.create({
            data: {
              type: AttachmentType.CONTRACT_SCREENSHOT,
              fileName: 'contract_form.pdf',
              mimeType: 'application/pdf',
              fileSize: 1024,
              storagePath: 'dummy/contract.pdf',
              createdById: ctx.user.id,
            },
          });
          const passportAtt = await this.prisma.attachment.create({
            data: {
              type: AttachmentType.PASSPORT_PHOTO,
              fileName: 'passport_scan.jpg',
              mimeType: 'image/jpeg',
              fileSize: 1024,
              storagePath: 'dummy/passport.jpg',
              createdById: ctx.user.id,
            },
          });

          const order = await this.ordersService.submitStage1Order({
            sellerId: ctx.user.id,
            programId: currentData.programId,
            storeId: currentData.storeId,
            customer: currentData.customer,
            contractEndDate: currentData.contractEndDate,
            items: currentData.items,
            daftarRejected: false,
            agentPercentage: 5,
            clientPayoutAmount: currentData.customer.withdrawableLimit,
            attachmentIds: [contractAtt.id, passportAtt.id],
          });

          await this.ordersService.clearDraft(ctx.user.id);

          // Post announcement to receipts group
          try {
            const groupSetting = await this.prisma.systemSetting.findUnique({
              where: { key: 'RECEIPTS_GROUP_ID' },
            });
            const groupId = process.env.RECEIPTS_GROUP_ID || groupSetting?.value;
            if (groupId) {
              await this.outboxService.enqueue('order_group_post', {
                chatId: groupId,
                message:
                  `📋 <b>ЯНГИ БУЮРТМА РАСМИЙЛАШТИРИЛДИ</b>\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `• Буюртма №: <b>${order.orderNumber}</b>\n` +
                  `• Мижоз: <b>${currentData.customer.fullName}</b> (${currentData.customer.phone1})\n` +
                  `• Жами прайс: <b>${DecimalUtil.formatMoney(order.totalPrice)}</b>\n` +
                  `• Ечиладиган лимит: <b>${DecimalUtil.formatMoney(currentData.customer.withdrawableLimit)}</b>\n` +
                  `• Ҳолати: <b>${order.status}</b>\n` +
                  `• Сотувчи: <b>${ctx.user?.firstName || 'Ходим'}</b>\n` +
                  `• Вақт: ${DateUtil.formatTashkent(new Date())}\n` +
                  `━━━━━━━━━━━━━━━━━━━━`,
              });
            }
          } catch {}

          const ik = new InlineKeyboard();
          if (order.status === OrderStatus.READY_FOR_HANDOFF) {
            ik.text('➡️ Операторга топшириш (Handoff)', `handoff_order:${order.id}`).row();
          }

          await ctx.reply(
            `🎉 <b>Буюртма муваффақиятли яратилди!</b>\n\n` +
            `• Буюртма рақами: <b>${order.orderNumber}</b>\n` +
            `• Мижоз: <b>${currentData.customer.fullName}</b>\n` +
            `• Жами сумма: <b>${DecimalUtil.formatMoney(order.totalPrice)}</b>\n` +
            `• Ҳолати: <b>${order.status}</b>\n\n` +
            (order.status === OrderStatus.READY_FOR_HANDOFF
              ? 'Буюртма 2-босқич операторига ўтказишга тайёр. Топшириш учун қуйидаги тугмани босинг:'
              : 'Буюртма якунланди (бу дастурда давом эттириш талаб этилмайди).'),
            { reply_markup: ik.inline_keyboard.length ? ik : undefined, parse_mode: 'HTML' },
          );
        } catch (err) {
          await ctx.reply(`❌ Расмийлаштиришда хатолик: ${(err as Error).message}`);
        }
        return;
      }

      // Reject daftar command with reason
      if (text.startsWith('/reject_daftar ')) {
        const parts = text.split(' ');
        const orderId = parts[1];
        const reason = parts.slice(2).join(' ');
        if (!reason) {
          await ctx.reply('Илтимос, сабабни киритинг: /reject_daftar <orderId> <сабаб>');
          return;
        }
        try {
          await this.daftarService.updateReviewStatus({
            orderId,
            reviewerId: ctx.user.id,
            status: DaftarStatus.NEEDS_CORRECTION,
            comment: reason,
          });
          await ctx.reply('✅ Буюртма сабаби кўрсатилиб, сотувчига қайтарилди!');
        } catch (err) {
          await ctx.reply(`Хатолик: ${(err as Error).message}`);
        }
        return;
      }

      // Search by Order number or receipt
      if (text.startsWith('ORD-')) {
        try {
          const order = await this.ordersService.getOrderByNumber(text, ctx.user.id);
          await this.renderOrderCard(ctx, order.id);
        } catch (err) {
          await ctx.reply(`Буюртма топилмади: ${text}`);
        }
        return;
      }

      if (text.startsWith('PAY-')) {
        try {
          const payment = await this.paymentsService.getPaymentByReceipt(text);
          await ctx.reply(
            `🧾 <b>Тўлов чеки: ${payment.receiptNumber}</b>\n` +
            `Буюртма: ${payment.sale.order.orderNumber}\n` +
            `Харидор: ${payment.sale.buyer.fullName}\n` +
            `Усул: ${payment.method}\n` +
            `Валюта: ${payment.currency} (${payment.originalAmount})\n` +
            `Ҳисобланган сумма: ${DecimalUtil.formatMoney(payment.calculatedAmount)}\n` +
            `Ҳолат: ${payment.status}\n` +
            `Сана: ${DateUtil.formatTashkent(payment.createdAt)}`,
            { parse_mode: 'HTML' },
          );
        } catch (err) {
          await ctx.reply(`Чек топилмади: ${text}`);
        }
        return;
      }
    });
  }

  // ===================== BUTTON HANDLERS & 36-POINT WIZARD =====================

  private async handleNewOrderButton(ctx: BotContext) {
    // Check role: SELLER or SUPER_ADMIN
    const isSeller =
      ctx.userRoles?.includes(RoleName.SELLER) ||
      ctx.userRoles?.includes(RoleName.SUPER_ADMIN);

    if (!isSeller) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    // Clear previous draft to ensure a fresh, instant experience
    await this.ordersService.clearDraft(ctx.user.id);

    const sellerFullName = [ctx.user?.firstName, ctx.user?.lastName].filter(Boolean).join(' ') || ctx.from?.first_name || 'Савдочи';
    const sellerTgId = ctx.user?.telegramId ? ` (${ctx.user.telegramId})` : (ctx.from?.id ? ` (${ctx.from.id})` : '');
    const nowTime = DateUtil.formatTashkent(new Date(), 'DD.MM.YYYY HH:mm:ss');

    const programs = await this.programsService.listActive();
    const ik = new InlineKeyboard();
    let col = 0;
    for (const p of programs) {
      let icon = '📱';
      const nameLower = p.name.toLowerCase();
      if (nameLower.includes('alif')) icon = '🟢';
      else if (nameLower.includes('anor')) icon = '🔴';
      else if (nameLower.includes('ishonch')) icon = '🔵';
      else if (nameLower.includes('uzum')) icon = '🍇';
      else if (nameLower.includes('payme')) icon = '📱';

      ik.text(`${icon} ${p.name}`, `wz_prog:${p.id}`);
      col++;
      if (col % 2 === 0) {
        ik.row();
      }
    }

    await ctx.reply(
      `🧾 <b>Янги чек уриш (1–20-бандлар):</b>\n\n` +
      `1️⃣ <b>Сана/Вақт:</b> <code>${nowTime}</code>\n` +
      `2️⃣ <b>Продавец исми:</b> <b>${sellerFullName}${sellerTgId}</b>\n\n` +
      `3️⃣ <b>Қайси дастур орқали:</b>\n` +
      `<i>(Керакли дастур тугмасини танланг):</i>`,
      { reply_markup: ik, parse_mode: 'HTML' },
    );
  }

  private async safeEditOrReply(ctx: BotContext, text: string, keyboard?: InlineKeyboard) {
    try {
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText(text, {
          reply_markup: keyboard,
          parse_mode: 'HTML',
        });
        return;
      }
    } catch {}

    await ctx.reply(text, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
    });
  }

  // ===================== STAGE 1 (1–20 POINTS) RENDERING METHODS =====================

  private async renderWzStep4Duration(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('3 ой', 'wz_dur:3')
      .text('6 ой', 'wz_dur:6')
      .text('9 ой', 'wz_dur:9')
      .row()
      .text('12 ой (1 йил)', 'wz_dur:12')
      .text('18 ой', 'wz_dur:18')
      .text('24 ой (2 йил)', 'wz_dur:24');

    await this.safeEditOrReply(
      ctx,
      `📱 Дастур: <b>${d.programName}</b>\n\n` +
      `4️⃣ <b>Срок окончания договора (Шартнома муддати):</b>\n\n` +
      `<i>(Муддат тугмаларидан бирини танланг):</i>`,
      ik,
    );
  }

  private async renderWzStep5Daftar(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('✅ Ҳа (Ўтказилади)', 'wz_daftar:yes')
      .text('❌ Йўқ (Ўтказилмайди)', 'wz_daftar:no');

    await this.safeEditOrReply(
      ctx,
      `📱 Дастур: <b>${d.programName}</b> (${d.durationMonths} ой)\n\n` +
      `5️⃣ <b>Дафтар дастуридан ўтказиладими?</b>\n\n` +
      `<i>(«Ҳа» ёки «Йўқ» тугмасини босинг):</i>`,
      ik,
    );
  }

  private async renderWzStep6CustomerName(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('👤 Савдочи номидан', 'wz_cname:self');

    await this.safeEditOrReply(
      ctx,
      `6️⃣ <b>Клиент (Имя Фамилия):</b>\n\n` +
      `<i>(Мижоз исм-фамилиясини ёзиб юборинг ёки тезкор тугмани босинг):</i>`,
      ik,
    );
  }

  private async renderWzStep7CustomerPhone1(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('📞 Савдочи рақамидан', 'wz_cphone1:self');

    await this.safeEditOrReply(
      ctx,
      `👤 Клиент: <b>${d.customerName}</b>\n\n` +
      `7️⃣ <b>Клиент рақами 1:</b>\n\n` +
      `<i>(Асосий телефон рақамини ёзиб юборинг, масалан: <code>+998901234567</code>):</i>`,
      ik,
    );
  }

  private async renderWzStep8CustomerPhone2(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('⏭ Ўтказиб юбориш (Йўқ)', 'wz_cphone2:skip');

    await this.safeEditOrReply(
      ctx,
      `📞 Тел 1: <b>${d.phone1}</b>\n\n` +
      `8️⃣ <b>Клиент рақами 2 (қўшимча):</b>\n\n` +
      `<i>(Иккинчи телефон рақамини ёзинг ёки «Ўтказиб юбориш» тугмасини босинг):</i>`,
      ik,
    );
  }

  private async renderWzStep9ContractScreen(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('⏭ Кейинроқ юклаш', 'wz_contract:skip');

    await this.safeEditOrReply(
      ctx,
      `9️⃣ <b>Договор скрин (Шартнома скриншоти/расми):</b>\n\n` +
      `<i>(Договор расмини юборинг ёки «Кейинроқ юклаш» тугмасини босинг):</i>`,
      ik,
    );
  }

  private async renderWzStep10PassportPhoto(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('⏭ Кейинроқ юклаш', 'wz_passport:skip');

    await this.safeEditOrReply(
      ctx,
      `🔟 <b>Фото клиента в руках с паспортом:</b>\n\n` +
      `<i>(Мижознинг қўлида паспорт билан тушган фотосини юборинг ёки «Кейинроқ юклаш» тугмасини босинг):</i>`,
      ik,
    );
  }

  private async renderWzStep11Store(ctx: BotContext, d: any) {
    const stores = await this.storesService.list();
    const ik = new InlineKeyboard();
    for (const s of stores) {
      ik.text(`🏪 ${s.name} (${s.address})`, `wz_store:${s.id}`).row();
    }

    await this.safeEditOrReply(
      ctx,
      `1️⃣1️⃣ <b>Магазин (Адрес, название магазина):</b>\n\n` +
      `<i>(Керакли дўкон тугмасини танланг):</i>`,
      ik,
    );
  }

  private async renderWzStep12GeneralLimit(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('1 000 000', 'wz_genlim:1000000')
      .text('1 300 000', 'wz_genlim:1300000')
      .row()
      .text('2 000 000', 'wz_genlim:2000000')
      .text('3 000 000', 'wz_genlim:3000000')
      .row()
      .text('5 000 000', 'wz_genlim:5000000')
      .text('10 000 000', 'wz_genlim:10000000')
      .row()
      .text('✏️ Бошқа сумма', 'wz_genlim:custom');

    await this.safeEditOrReply(
      ctx,
      `🏪 Дўкон: <b>${d.storeName}</b>\n\n` +
      `1️⃣2️⃣ <b>Клиент умумий лимити:</b>\n\n` +
      `<i>(Тайёр суммани танланг ёки рақамда ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWzStep13WithdrawableLimit(ctx: BotContext, d: any) {
    const genFormatted = DecimalUtil.formatMoney(d.generalLimit, "so'm");
    const ik = new InlineKeyboard()
      .text(`💯 100% (${genFormatted})`, 'wz_withlim:full')
      .row()
      .text('1 000 000', 'wz_withlim:1000000')
      .text('1 300 000', 'wz_withlim:1300000')
      .row()
      .text('2 000 000', 'wz_withlim:2000000')
      .text('✏️ Бошқа сумма', 'wz_withlim:custom');

    await this.safeEditOrReply(
      ctx,
      `💰 Умумий лимит: <b>${genFormatted}</b>\n\n` +
      `1️⃣3️⃣ <b>Клиентдан ечиладиган лимит суммаси:</b>\n\n` +
      `<i>(Ечиладиган лимит умумий лимитдан ошмаслиги лозим):</i>`,
      ik,
    );
  }

  private async renderWzStep14ProductPrice(ctx: BotContext, d: any) {
    const withFormatted = DecimalUtil.formatMoney(d.withdrawableLimit, "so'm");
    const ik = new InlineKeyboard()
      .text(`🏷 Ечиладиган лимит билан бир хил (${withFormatted})`, 'wz_price:same')
      .row()
      .text('✏️ Бошқа прайс нарх', 'wz_price:custom');

    await this.safeEditOrReply(
      ctx,
      `💰 Ечиладиган лимит: <b>${withFormatted}</b>\n\n` +
      `1️⃣4️⃣ <b>Маҳсулот прайс нархи:</b>\n\n` +
      `<i>(Прайс нархини танланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWzStep15Percentage(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('0%', 'wz_pct:0')
      .text('10%', 'wz_pct:10')
      .text('15%', 'wz_pct:15')
      .row()
      .text('20%', 'wz_pct:20')
      .text('25%', 'wz_pct:25')
      .text('30%', 'wz_pct:30')
      .row()
      .text('35%', 'wz_pct:35')
      .text('✏️ Бошқа фоиз', 'wz_pct:custom');

    await this.safeEditOrReply(
      ctx,
      `🏷 Прайс нархи: <b>${DecimalUtil.formatMoney(d.productPrice, "so'm")}</b>\n\n` +
      `1️⃣5️⃣ <b>Агент %:</b>\n\n` +
      `<i>(Керакли фоиз тугмасини танланг):</i>`,
      ik,
    );
  }

  private async renderWzStep17ProductName(ctx: BotContext, d: any) {
    const defaultName = `${d.programName} — 1 ta`;
    const ik = new InlineKeyboard()
      .text(`📱 ${defaultName}`, 'wz_prod:default')
      .row()
      .text('📱 iPhone 15 Pro — 1 ta', 'wz_prod:ip15p')
      .text('📱 iPhone 14 — 1 ta', 'wz_prod:ip14')
      .row()
      .text('📱 Samsung Galaxy S24', 'wz_prod:s24')
      .row()
      .text('✏️ Бошқа маҳсулот номи', 'wz_prod:custom');

    const payoutFormatted = DecimalUtil.formatMoney(d.clientPayoutAmount, "so'm");

    await this.safeEditOrReply(
      ctx,
      `📊 Танланган фоиз: <b>${d.foiz}%</b>\n` +
      `1️⃣6️⃣ <b>Клиентга бериладиган сумма:</b> <b>${payoutFormatted}</b>\n\n` +
      `1️⃣7️⃣ <b>Маҳсулот тури (тўлиқ номи) ва сони:</b>\n\n` +
      `<i>(Маҳсулот номини танланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWzStep18ImeiBarcode(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('⏭ Кейинроқ киритиш', 'wz_imei:skip');

    await this.safeEditOrReply(
      ctx,
      `📦 Маҳсулот: <b>${d.productName}</b>\n\n` +
      `1️⃣8️⃣ <b>Телефон бўлса IMEI коди, техника бўлса баркоди:</b>\n\n` +
      `<i>(IMEI ёки баркодни ёзиб юборинг ёки «Кейинроқ киритиш» тугмасини босинг):</i>`,
      ik,
    );
  }

  private async renderWzStep19Quantity(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('1 та', 'wz_qty:1')
      .text('2 та', 'wz_qty:2')
      .text('3 та', 'wz_qty:3')
      .row()
      .text('✏️ Бошқа сон', 'wz_qty:custom');

    await this.safeEditOrReply(
      ctx,
      `1️⃣9️⃣ <b>Умумий маҳсулот сони:</b>\n\n` +
      `<i>(Маҳсулот сонини танланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWzStep20DaftarStatus(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('✅ Подтверждено', `wz_daft_stat:${DaftarStatus.APPROVED}`)
      .text('⚠️ Надо исправить', `wz_daft_stat:${DaftarStatus.NEEDS_CORRECTION}`)
      .row()
      .text('⏳ В ожидание', `wz_daft_stat:${DaftarStatus.PENDING}`)
      .text('🚫 Не требуется', `wz_daft_stat:${DaftarStatus.NOT_REQUIRED}`);

    await this.safeEditOrReply(
      ctx,
      `🔢 Маҳсулот сони: <b>${d.quantity || 1} та</b>\n\n` +
      `2️⃣0️⃣ <b>Подтверждение дафтар:</b>\n\n` +
      `<i>(Ҳолат тугмаларидан бирини босинг):</i>`,
      ik,
    );
  }

  private async renderWzStage1Preview(ctx: BotContext, d: any) {
    const sellerFullName = [ctx.user?.firstName, ctx.user?.lastName].filter(Boolean).join(' ') || ctx.from?.first_name || 'Савдочи';
    const sellerTgId = ctx.user?.telegramId ? ` (${ctx.user.telegramId})` : (ctx.from?.id ? ` (${ctx.from.id})` : '');
    const nowTime = DateUtil.formatTashkent(new Date(), 'DD.MM.YYYY HH:mm:ss');
    const genLimFormatted = DecimalUtil.formatMoney(d.generalLimit || d.withdrawableLimit || 1300000, "so'm");
    const withLimFormatted = DecimalUtil.formatMoney(d.withdrawableLimit || 1300000, "so'm");
    const payoutFormatted = DecimalUtil.formatMoney(d.clientPayoutAmount || 910000, "so'm");
    const priceFormatted = DecimalUtil.formatMoney(d.productPrice || d.withdrawableLimit || 1300000, "so'm");

    const ik = new InlineKeyboard()
      .text('✅ Чекни уриш ва Гуруҳга чиқариш', 'wz_submit_confirm')
      .row()
      .text('❌ Бекор қилиш', 'wz_cancel');

    const previewMsg =
      `📋 <b>Янги буюртма маълумотлари (1–20-бандлар):</b>\n\n` +
      `1. Дата/Время: <b>${nowTime}</b>\n` +
      `2. Продавец исми: <b>${sellerFullName}${sellerTgId}</b>\n` +
      `3. Қайси дастур: <b>${d.programName}</b>\n` +
      `4. Шартнома муддати: <b>${d.durationMonths || 12} ой</b>\n` +
      `5. Дафтардан ўтказиладими: <b>${d.daftarRejected ? 'Ҳа' : 'Йўқ'}</b>\n` +
      `6. Клиент: <b>${d.customerName || 'Мижоз'}</b>\n` +
      `7. Тел 1: <b>${d.phone1 || '—'}</b>\n` +
      `8. Тел 2: <b>${d.phone2 || '—'}</b>\n` +
      `9. Договор скрин: <b>${d.contractPhoto ? 'Юкланди' : 'Кейинроқ'}</b>\n` +
      `10. Фото паспортом: <b>${d.passportPhoto ? 'Юкланди' : 'Кейинроқ'}</b>\n` +
      `11. Магазин: <b>${d.storeName || '—'}</b>\n` +
      `12. Умумий лимит: <b>${genLimFormatted}</b>\n` +
      `13. Ечиладиган лимит: <b>${withLimFormatted}</b>\n` +
      `14. Прайс нархи: <b>${priceFormatted}</b>\n` +
      `15. Агент %: <b>${d.foiz}%</b>\n` +
      `16. Клиентга бериладиган сумма: <b>${payoutFormatted}</b>\n` +
      `17. Маҳсулот: <b>${d.productName || '—'}</b>\n` +
      `18. IMEI/Баркод: <b>${d.imeiOrBarcode || '—'}</b>\n` +
      `19. Сони: <b>${d.quantity || 1} та</b>\n` +
      `20. Дафтар ҳолати: <b>${DAFTAR_STATUS_TEXTS[d.daftarStatus as DaftarStatus] || 'PENDING'}</b>\n\n` +
      `<i>Маълумотлар тўғри бўлса, «Чекни уриш ва Гуруҳга чиқариш» тугмасини босинг:</i>`;

    await this.safeEditOrReply(ctx, previewMsg, ik);
  }

  private async submitStage1Order36(ctx: BotContext) {
    const draft = await this.ordersService.getDraft(ctx.user.id);
    const d = (draft?.formData as any) || {};

    if (!d.programId || !d.storeId) {
      await ctx.reply('❌ Буюртма маълумотлари тўлиқ эмас. Қайта бошланг.');
      return;
    }

    try {
      const order = await this.ordersService.createStage1Order36({
        sellerId: ctx.user.id,
        programId: d.programId,
        storeId: d.storeId,
        contractEndDate: d.contractEndDate ? new Date(d.contractEndDate) : new Date(Date.now() + 365 * 24 * 3600 * 1000),
        daftarRejected: !!d.daftarRejected,
        customer: {
          fullName: d.customerName || [ctx.user?.firstName, ctx.user?.lastName].filter(Boolean).join(' ') || 'Мижоз',
          phone1: d.phone1 || ctx.user?.phone || `+998${ctx.user?.telegramId?.toString().slice(-9) || '901234567'}`,
          phone2: d.phone2 || null,
          generalLimit: d.generalLimit || d.withdrawableLimit || 1300000,
          withdrawableLimit: d.withdrawableLimit || 1300000,
        },
        productPrice: d.productPrice || d.withdrawableLimit || 1300000,
        agentPercentage: d.foiz || 0,
        clientPayoutAmount: d.clientPayoutAmount || d.withdrawableLimit || 1300000,
        productName: d.productName || `${d.programName} — 1 ta`,
        imeiOrBarcode: d.imeiOrBarcode || null,
        quantity: d.quantity || 1,
        daftarStatus: (d.daftarStatus as DaftarStatus) || DaftarStatus.PENDING,
      });

      // Clear draft
      await this.ordersService.clearDraft(ctx.user.id);

      // Generate receipt text strictly conforming to quick-check format
      const receiptText = formatReceiptText(order as any);

      // Post receipt to receipts group with ombor buttons
      try {
        const groupSetting = await this.prisma.systemSetting.findUnique({
          where: { key: 'RECEIPTS_GROUP_ID' },
        });
        const groupId = process.env.RECEIPTS_GROUP_ID || groupSetting?.value;
        if (groupId) {
          const groupKeyboard = new InlineKeyboard()
            .text('✅ Омбор: Тасдиқлаш', `ombor_confirm:${order.id}`)
            .text('❌ Омбор: Бекор қилиш', `ombor_cancel:${order.id}`);

          await this.outboxService.enqueue('order_receipt_group', {
            chatId: groupId,
            message: `<pre>${receiptText}</pre>`,
            replyMarkup: groupKeyboard,
          });
        }
      } catch (postErr) {
        this.logger.error('Failed to post receipt to group', postErr);
      }

      // Check continuation condition:
      // !!! Агарда «Trust 1 (Ishonch)», «Alif 6 ойлик», «Alif Кодирака» дастурлари оркали болмаса.
      // Ботда «Буйутрмани утказиш» кнопкаси чикиши кере болади. Бундан сонг буйуртма янги давом этдирувчи шахсга келиб тушади. Сонги давом этиб кетади.
      const ik = new InlineKeyboard();
      if (order.program?.requiresContinuation) {
        ik.text('➡️ Буйуртмани ўтказиш', `handoff_order:${order.id}`).row();
      }

      await ctx.reply(
        `🎉 <b>Чек муваффақиятли урилди ва гуруҳга чиқарилди!</b>\n\n` +
        `<pre>${receiptText}</pre>\n\n` +
        (order.program?.requiresContinuation
          ? `⚠️ <i>Ушбу дастур бўйича буюртмани 2-давом эттирувчи шахсга ўтказиш керак:</i>`
          : `✅ <i>Ушбу дастурда давом эттириш талаб этилмайди (Якунланди).</i>`),
        { reply_markup: ik.inline_keyboard.length ? ik : undefined, parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.reply(`❌ Чек уришда хатолик: ${(err as Error).message}`);
    }
  }

  // ===================== STAGE 2 (21–34 POINTS) METHODS =====================

  private async startStage2Wizard(ctx: BotContext, orderId: string) {
    const order = await this.ordersService.getOrderById(orderId, ctx.user.id);
    const draftData = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderPrice: Number(order.totalPrice),
      productName: order.items[0]?.model || `${order.program.name} — 1 ta`,
      buyerName: order.customer.fullName,
      buyerPhone: order.customer.phone1,
      plannedSalePrice: Number(order.totalPrice),
      actualSalePrice: Number(order.totalPrice),
    };

    await this.ordersService.saveDraft(ctx.user.id, 'WZ2_21_PRODUCT_STATUS', draftData);
    await this.renderWz2Step21ProductStatus(ctx, draftData);
  }

  private async renderWz2Step21ProductStatus(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('🏢 На складе', `wz2_stat:${InventoryUnitStatus.IN_STOCK}`)
      .text('🛍 Продано', `wz2_stat:${InventoryUnitStatus.SOLD}`)
      .row()
      .text('🚚 В пути', `wz2_stat:${InventoryUnitStatus.IN_TRANSIT}`)
      .text('⏳ Ожидается', `wz2_stat:${InventoryUnitStatus.EXPECTED}`);

    await this.safeEditOrReply(
      ctx,
      `📦 Буюртма: <b>${d.orderNumber}</b> (${d.productName})\n\n` +
      `2️⃣1️⃣ <b>Маҳсулот статуси:</b>\n\n` +
      `<i>(Керакли маҳсулот ҳолатини танланг):</i>`,
      ik,
    );
  }

  private async renderWz2Step22Agency(ctx: BotContext, d: any) {
    const agencies = await this.agenciesService.list();
    const ik = new InlineKeyboard();
    let col = 0;
    for (const a of agencies) {
      ik.text(`🤝 ${a.name}`, `wz2_ag:${a.id}`);
      col++;
      if (col % 2 === 0) ik.row();
    }
    if (col % 2 !== 0) ik.row();
    ik.text('🚫 Агентсиз', 'wz2_ag:none');

    await this.safeEditOrReply(
      ctx,
      `2️⃣2️⃣ <b>Агентлик эгаси (Исми):</b>\n\n` +
      `<i>(Керакли агентлик тугмасини танланг):</i>`,
      ik,
    );
  }

  private async renderWz2Step23AgencyEmployee(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard();
    if (d.agencyId && d.agencyId !== 'none') {
      const emps = await this.agenciesService.getEmployeesByAgency(d.agencyId);
      for (const e of emps) {
        ik.text(`👔 ${e.fullName}`, `wz2_emp:${e.id}`).row();
      }
    }
    ik.text('⏭ Ўтказиб юбориш (Ходимсиз)', 'wz2_emp:none');

    await this.safeEditOrReply(
      ctx,
      `🤝 Агент: <b>${d.agencyName || 'Agentsiz'}</b>\n\n` +
      `2️⃣3️⃣ <b>Агент ходими (Исми):</b>\n\n` +
      `<i>(Агент ходимини танланг ёки ўтказиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step24BuyerAddress(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('📍 Малика бозори, 15-дўкон', 'wz2_addr:malika')
      .row()
      .text('📍 Абу Сахий, 120-дўкон', 'wz2_addr:abusaxiy')
      .row()
      .text('✏️ Бошқа манзил ёзиш', 'wz2_addr:custom');

    await this.safeEditOrReply(
      ctx,
      `2️⃣4️⃣ <b>Техникани харид қилувчининг манзили ва дўкон рақами:</b>\n\n` +
      `<i>(Манзилни танланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step27PlannedPrice(ctx: BotContext, d: any) {
    const priceFormatted = DecimalUtil.formatMoney(d.orderPrice || 1300000, "so'm");
    const ik = new InlineKeyboard()
      .text(`🏷 Прайс бўйича (${priceFormatted})`, 'wz2_planned:order')
      .row()
      .text('✏️ Бошқа режавий нарх', 'wz2_planned:custom');

    await this.safeEditOrReply(
      ctx,
      `👤 Харидор: <b>${d.buyerName}</b> (${d.buyerPhone})\n\n` +
      `2️⃣7️⃣ <b>Техниканинг сотилиш нархи (Режавий):</b>\n\n` +
      `<i>(Нархни танланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step28ActualPrice(ctx: BotContext, d: any) {
    const planFormatted = DecimalUtil.formatMoney(d.plannedSalePrice || 1300000, "so'm");
    const ik = new InlineKeyboard()
      .text(`💵 Режавий нарх билан бир хил (${planFormatted})`, 'wz2_actual:same')
      .row()
      .text('✏️ Бошқа сотилган нарх', 'wz2_actual:custom');

    await this.safeEditOrReply(
      ctx,
      `🏷 Режавий нарх: <b>${planFormatted}</b>\n\n` +
      `2️⃣8️⃣ <b>Техниканинг сотилган нархи (Ҳақиқий):</b>\n\n` +
      `<i>(Ҳақиқий сотилган нархни танланг ёки ёзинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step29PaymentMethod(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('💵 Нақд', 'wz2_paymeth:CASH')
      .text('💳 Сўм карта', 'wz2_paymeth:UZS_CARD')
      .row()
      .text('💵 $ (USD)', 'wz2_paymeth:USD_CASH')
      .text('🏦 Перечисление', 'wz2_paymeth:BANK_TRANSFER');

    await this.safeEditOrReply(
      ctx,
      `💵 Сотилган нарх: <b>${DecimalUtil.formatMoney(d.actualSalePrice || 1300000, "so'm")}</b>\n\n` +
      `2️⃣9️⃣ <b>Тўлов тури:</b>\n\n` +
      `<i>(Тўлов усулини танланг):</i>`,
      ik,
    );
  }

  private async renderWz2Step29PaymentAmount(ctx: BotContext, d: any) {
    const actualFormatted = DecimalUtil.formatMoney(d.actualSalePrice || 1300000, "so'm");
    const ik = new InlineKeyboard()
      .text(`💯 Тўлиқ тўланди (${actualFormatted})`, 'wz2_payamt:full')
      .row()
      .text('0️⃣ Ҳозирча 0 (Тўланмади)', 'wz2_payamt:0')
      .row()
      .text('✏️ Бошқа тўланган сумма', 'wz2_payamt:custom');

    await this.safeEditOrReply(
      ctx,
      `💳 Тўлов усули: <b>${d.paymentMethod}</b>\n\n` +
      `2️⃣9️⃣ <b>Тўланган сумма:</b>\n\n` +
      `<i>(Тўланган суммани танланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step30HasDebt(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('🟢 Йўқ (Қарз йўқ)', 'wz2_hasdebt:no')
      .text('🔴 Ҳа (Қарз бор)', 'wz2_hasdebt:yes');

    const remFormatted = DecimalUtil.formatMoney(d.remainingAmount || 0, "so'm");

    await this.safeEditOrReply(
      ctx,
      `💵 Тўланди: <b>${DecimalUtil.formatMoney(d.paidAmount || 0, "so'm")}</b>\n` +
      `💰 Қолдиқ сумма: <b>${remFormatted}</b>\n\n` +
      `3️⃣0️⃣ <b>Техниканинг қолдиқ суммаси борми?</b>\n\n` +
      `<i>(Керакли тугмани танланг):</i>`,
      ik,
    );
  }

  private async renderWz2Step31RemainingAmount(ctx: BotContext, d: any) {
    const remFormatted = DecimalUtil.formatMoney(d.remainingAmount || 0, "so'm");
    const ik = new InlineKeyboard()
      .text(`💰 Ҳисобланган: ${remFormatted}`, 'wz2_remamt:calc')
      .row()
      .text('✏️ Бошқа қолдиқ сумма', 'wz2_remamt:custom');

    await this.safeEditOrReply(
      ctx,
      `3️⃣1️⃣ <b>Техниканинг (қолдиқ суммаси):</b>\n\n` +
      `<i>(Қолдиқ суммани тасдиқланг ёки ёзиб юборинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step32DueDate(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('3 кун', 'wz2_duedate:3')
      .text('7 кун', 'wz2_duedate:7')
      .row()
      .text('15 кун', 'wz2_duedate:15')
      .text('1 ой (30 кун)', 'wz2_duedate:30')
      .row()
      .text('✏️ Бошқа сана', 'wz2_duedate:custom');

    await this.safeEditOrReply(
      ctx,
      `💰 Қолдиқ қарз: <b>${DecimalUtil.formatMoney(d.remainingAmount || 0, "so'm")}</b>\n\n` +
      `3️⃣2️⃣ <b>Техниканинг қолдиқ суммасини ёпиш вақти:</b>\n\n` +
      `<i>(Тўлов муддатини танланг ёки ёзинг):</i>`,
      ik,
    );
  }

  private async renderWz2Step33VideoNote(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('⏭ Ўтказиб юбориш (Кейинроқ)', 'wz2_video:skip');

    await this.safeEditOrReply(
      ctx,
      `3️⃣3️⃣ <b>Техниканинг Баркоди, IMEI, характеристикасини думалоқ видеога олиш:</b>\n\n` +
      `📹 <i>Мижозга қолдиқ суммасини ва якуний тўлов вақтини айтириб думалоқ видео (видео хабар) кўринишида юборинг ёки «Ўтказиб юбориш» тугмасини босинг:</i>`,
      ik,
    );
  }

  private async renderWz2Step34PaymentStatus(ctx: BotContext, d: any) {
    const ik = new InlineKeyboard()
      .text('🟢 Оплачено', `wz2_paystat:${PaymentStatus.PAID}`)
      .text('🔴 Долг (Дебит)', `wz2_paystat:${PaymentStatus.DEBT}`)
      .row()
      .text('🟡 Частично', `wz2_paystat:${PaymentStatus.PARTIAL}`);

    await this.safeEditOrReply(
      ctx,
      `3️⃣4️⃣ <b>Тўлов статуси:</b>\n\n` +
      `<i>(Керакли тўлов ҳолатини танланг):</i>`,
      ik,
    );
  }

  private async renderWz2Preview(ctx: BotContext, d: any) {
    const planFormatted = DecimalUtil.formatMoney(d.plannedSalePrice || 1300000, "so'm");
    const actFormatted = DecimalUtil.formatMoney(d.actualSalePrice || 1300000, "so'm");
    const paidFormatted = DecimalUtil.formatMoney(d.paidAmount || 0, "so'm");
    const remFormatted = DecimalUtil.formatMoney(d.remainingAmount || 0, "so'm");
    const dueStr = d.debtDueDate ? DateUtil.formatDateTashkent(new Date(d.debtDueDate)) : '—';

    const ik = new InlineKeyboard()
      .text('✅ Сотувни тасдиқлаш ва якунлаш', 'wz2_confirm')
      .row()
      .text('❌ Бекор қилиш', 'wz_cancel');

    const msg =
      `📋 <b>Сотувни тасдиқлаш (21–34-бандлар):</b>\n\n` +
      `21. Маҳсулот статуси: <b>${d.inventoryStatus}</b>\n` +
      `22. Агентлик эгаси: <b>${d.agencyName || 'Agentsiz'}</b>\n` +
      `23. Агент ходими: <b>${d.agencyEmployeeName || '—'}</b>\n` +
      `24. Харидор манзили: <b>${d.buyerAddress || '—'}</b>\n` +
      `25. Харидор исми: <b>${d.buyerName}</b>\n` +
      `26. Харидор рақами: <b>${d.buyerPhone}</b>\n` +
      `27. Сотилиш (режавий) нархи: <b>${planFormatted}</b>\n` +
      `28. Сотилган (ҳақиқий) нархи: <b>${actFormatted}</b>\n` +
      `29. Тўлов тури: <b>${d.paymentMethod}</b> | Тўланди: <b>${paidFormatted}</b>\n` +
      `30. Қолдиқ сумма борми: <b>${d.hasDebt ? 'Ҳа' : 'Йўқ'}</b>\n` +
      `31. Қолдиқ қарз суммаси: <b>${remFormatted}</b>\n` +
      `32. Қарзни ёпиш вақти: <b>${dueStr}</b>\n` +
      `33. Видео тасдиқ: <b>${d.videoFileId ? 'Юкланди' : 'Йўқ'}</b>\n` +
      `34. Тўлов статуси: <b>${d.paymentStatus}</b>\n\n` +
      `<i>Маълумотлар тўғри бўлса, «Сотувни тасдиқлаш ва якунлаш» тугмасини босинг:</i>`;

    await this.safeEditOrReply(ctx, msg, ik);
  }

  private async submitStage2Sale36(ctx: BotContext) {
    const draft = await this.ordersService.getDraft(ctx.user.id);
    const d = (draft?.formData as any) || {};

    if (!d.orderId) {
      await ctx.reply('❌ Буюртма маълумотлари топилмади.');
      return;
    }

    try {
      let videoAttId: string | null = null;
      if (d.videoFileId) {
        const att = await this.prisma.attachment.create({
          data: {
            type: AttachmentType.VIDEO_NOTE,
            fileName: `video_note_${d.orderId}.mp4`,
            mimeType: 'video/mp4',
            fileSize: 1024,
            storagePath: `telegram_file_id:${d.videoFileId}`,
            createdById: ctx.user.id,
          },
        });
        videoAttId = att.id;
      }

      const sale = await this.salesService.createFullSale36({
        orderId: d.orderId,
        operatorId: ctx.user.id,
        inventoryStatus: (d.inventoryStatus as InventoryUnitStatus) || InventoryUnitStatus.SOLD,
        agencyId: d.agencyId || null,
        agencyEmployeeId: d.agencyEmployeeId || null,
        buyer: {
          fullName: d.buyerName || 'Харидор',
          phone: d.buyerPhone || '+998901234567',
          address: d.buyerAddress || 'Малика бозори',
        },
        plannedSalePrice: d.plannedSalePrice || 1300000,
        actualSalePrice: d.actualSalePrice || 1300000,
        paidAmount: d.paidAmount || 0,
        paymentMethod: d.paymentMethod || 'CASH',
        hasDebt: !!d.hasDebt,
        remainingAmount: d.remainingAmount || 0,
        debtDueDate: d.debtDueDate ? new Date(d.debtDueDate) : null,
        videoAttachmentId: videoAttId,
        paymentStatus: (d.paymentStatus as PaymentStatus) || PaymentStatus.PAID,
      });

      await this.ordersService.clearDraft(ctx.user.id);

      // Post sale announcement to receipts group
      try {
        const groupSetting = await this.prisma.systemSetting.findUnique({
          where: { key: 'RECEIPTS_GROUP_ID' },
        });
        const groupId = process.env.RECEIPTS_GROUP_ID || groupSetting?.value;
        if (groupId) {
          await this.outboxService.enqueue('sale_group_announcement', {
            chatId: groupId,
            message:
              `🛍 <b>СОТУВ ЯКУНЛАНДИ (2-БОСҚИЧ)</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `• Буюртма №: <b>${sale.order.orderNumber}</b>\n` +
              `• Харидор: <b>${sale.buyer.fullName}</b> (${sale.buyer.phone})\n` +
              `• Сотилган нарх: <b>${DecimalUtil.formatMoney(sale.actualSalePrice)}</b>\n` +
              `• Тўланди: <b>${DecimalUtil.formatMoney(sale.paidAmount)}</b>\n` +
              `• Қолдиқ қарз: <b>${DecimalUtil.formatMoney(sale.remainingAmount)}</b>\n` +
              `• Ҳолат: <b>${sale.paymentStatus}</b>\n` +
              `• Оператор: <b>${sale.operator.firstName || 'Ходим'}</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━`,
          });
        }
      } catch {}

      await ctx.reply(
        `🎉 <b>Сотув муваффақиятли расмийлаштирилди ва якунланди!</b>\n\n` +
        `• Буюртма: <b>${sale.order.orderNumber}</b>\n` +
        `• Харидор: <b>${sale.buyer.fullName}</b>\n` +
        `• Ҳақиқий сотилган нарх: <b>${DecimalUtil.formatMoney(sale.actualSalePrice)}</b>\n` +
        `• Қолдиқ қарз: <b>${DecimalUtil.formatMoney(sale.remainingAmount)}</b>\n` +
        `• Тўлов ҳолати: <b>${sale.paymentStatus}</b>`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.reply(`❌ Сотувни сақлашда хатолик: ${(err as Error).message}`);
    }
  }

  // ===================== POINTS 35 & 36 DEBT METHODS =====================

  private async renderDebtPaymentMethods(ctx: BotContext, saleId: string) {
    const sale = await this.salesService.getSaleById(saleId);
    const ik = new InlineKeyboard()
      .text('💵 Нақд', `debt_meth:${saleId}:CASH`)
      .text('💳 Сўм карта', `debt_meth:${saleId}:UZS_CARD`)
      .row()
      .text('💵 $ (USD)', `debt_meth:${saleId}:USD_CASH`)
      .text('🏦 Перечисление', `debt_meth:${saleId}:BANK_TRANSFER`);

    await ctx.reply(
      `3️⃣6️⃣ <b>Остатка сумма қабул қилиш:</b>\n\n` +
      `• Буюртма: <b>${sale.order.orderNumber}</b>\n` +
      `• Харидор: <b>${sale.buyer.fullName}</b>\n` +
      `• Қолдиқ қарз: <b>${DecimalUtil.formatMoney(sale.remainingAmount)}</b>\n\n` +
      `<i>(Тўлов турини танланг):</i>`,
      { reply_markup: ik, parse_mode: 'HTML' },
    );
  }

  private async renderDebtAmountPrompt(ctx: BotContext, saleId: string, methodStr: string) {
    const sale = await this.salesService.getSaleById(saleId);
    const remFormatted = DecimalUtil.formatMoney(sale.remainingAmount);

    await this.ordersService.saveDraft(ctx.user.id, 'DEBT_INPUT_AMOUNT', {
      saleId,
      methodStr,
      remainingAmount: Number(sale.remainingAmount),
    });

    const ik = new InlineKeyboard()
      .text(`💯 Тўлиқ ёпиш (${remFormatted})`, `debt_amt:${saleId}:full`)
      .row()
      .text('✏️ Бошқа сумма киритиш', `debt_amt:${saleId}:custom`);

    await ctx.reply(
      `💰 <b>Тўлов суммасини киритинг:</b>\n\n` +
      `• Тўлов тури: <b>${methodStr}</b>\n` +
      `• Қолдиқ қарз: <b>${remFormatted}</b>\n\n` +
      `<i>(Тўлиқ ёпиш тугмасини босинг ёки суммани рақамда ёзиб юборинг):</i>`,
      { reply_markup: ik, parse_mode: 'HTML' },
    );
  }

  private async executeDebtPayment(ctx: BotContext, saleId: string, methodStr: string, amountNum: number) {
    try {
      const pMethod = methodStr as PaymentMethod;
      const isUsd = methodStr === 'USD_CASH';
      const currency = isUsd ? Currency.USD : Currency.UZS;

      const payment = await this.paymentsService.recordPayment({
        saleId,
        method: pMethod,
        currency,
        originalAmount: amountNum,
        exchangeRate: isUsd ? 12800 : undefined,
        createdById: ctx.user.id,
      });

      await this.ordersService.clearDraft(ctx.user.id);

      await ctx.reply(
        `✅ <b>Қарздорлик бўйича тўлов муваффақиятли қабул қилинди!</b>\n\n` +
        `🧾 Чек: <b>${payment.receiptNumber}</b>\n` +
        `• Тўланган сумма: <b>${DecimalUtil.formatMoney(payment.calculatedAmount)}</b>\n` +
        `• Тўлов усули: <b>${payment.method}</b>\n` +
        `• Вақт: ${DateUtil.formatTashkent(payment.createdAt)}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.reply(`❌ Тўловни қабул қилишда хатолик: ${(err as Error).message}`);
    }
  }

  private async handleDraftsButton(ctx: BotContext) {
    const draft = await this.ordersService.getDraft(ctx.user.id);
    if (!draft) {
      await ctx.reply('Сизда сақланган қораламалар мавжуд эмас.');
      return;
    }
    await ctx.reply(
      `📝 Сизнинг қораламангиз:\nБосқич: ${draft.step}\nОхирги сақланган вақт: ${DateUtil.formatTashkent(draft.updatedAt)}`,
    );
  }

  private async handleMyOrdersButton(ctx: BotContext) {
    const orders = await this.ordersService.listMyOrders(ctx.user.id);
    if (orders.length === 0) {
      await ctx.reply('Сизга тегишли буюртмалар топилмади.');
      return;
    }

    let text = '📋 <b>Сизнинг буюртмаларингиз / чекларингиз:</b>\n\n';
    const ik = new InlineKeyboard();

    for (const o of orders.slice(0, 10)) {
      text += `• <b>${o.orderNumber}</b> | ${o.customer.fullName} | ${o.status}\n  Сумма: ${DecimalUtil.formatMoney(o.totalPrice)}\n\n`;
      ik.text(`📄 ${o.orderNumber}`, `view_order:${o.id}`).row();
    }

    // Excel export button at the bottom
    ik.text('📥 Excel кўринишида юклаб олиш (.xlsx)', 'export_my_orders_excel').row();

    await ctx.reply(text, { reply_markup: ik, parse_mode: 'HTML' });
  }

  private async handleExportOrdersExcel(ctx: BotContext) {
    try {
      await ctx.reply('⏳ <b>Excel файли тайёрланмоқда, илтимос кутинг...</b>', { parse_mode: 'HTML' });
      const orders = await this.ordersService.getAllOrdersForExport(ctx.user.id);
      if (orders.length === 0) {
        await ctx.reply('Юклаб олиш учун буюртмалар/чеклар мавжуд эмас.');
        return;
      }

      const buffer = await ExcelUtil.generateOrdersWorkbook(orders as any);
      const dateStr = DateUtil.formatTashkent(new Date(), 'YYYY-MM-DD_HH-mm');
      const fileName = `Cheklar_${dateStr}.xlsx`;

      await ctx.replyWithDocument(new InputFile(buffer, fileName), {
        caption:
          `📊 <b>Сизнинг барча чекларингиз Excel ҳисоботи:</b>\n\n` +
          `• Жами чеклар: <b>${orders.length} та</b>\n` +
          `• Ҳар бир маълумот алоҳида катакда чиройли шакллантирилди.\n` +
          `• Сана: <code>${DateUtil.formatTashkent(new Date(), 'DD.MM.YYYY HH:mm')}</code>`,
        parse_mode: 'HTML',
      });
    } catch (err) {
      this.logger.error('Failed to export orders excel', err);
      await ctx.reply(`❌ Excel файлини шакллантиришда хатолик юз берди: ${(err as Error).message}`);
    }
  }

  private async handleIncomingQueueButton(ctx: BotContext) {
    const isOperator =
      ctx.userRoles?.includes(RoleName.CONTINUATION_OPERATOR) ||
      ctx.userRoles?.includes(RoleName.SUPER_ADMIN);

    if (!isOperator) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    const queue = await this.assignmentsService.listIncomingQueue(ctx.user.id);
    if (queue.length === 0) {
      await ctx.reply('📥 Қабул қилиш навбатида ҳозирча буюртмалар йўқ.');
      return;
    }

    let text = '📥 <b>Қабул қилиш кутилаётган буюртмалар:</b>\n\n';
    const ik = new InlineKeyboard();

    for (const o of queue) {
      text += `• <b>${o.orderNumber}</b> (${o.customer.fullName})\n  Сотувчи: ${o.seller.firstName || ''}\n  Сумма: ${DecimalUtil.formatMoney(o.totalPrice)}\n\n`;
      ik.text(`✅ Қабул қилиш (${o.orderNumber})`, `accept_order:${o.id}`).row();
    }

    await ctx.reply(text, { reply_markup: ik, parse_mode: 'HTML' });
  }

  private async handleDaftarReviewButton(ctx: BotContext) {
    const isReviewer =
      ctx.userRoles?.includes(RoleName.DAFTAR_REVIEWER) ||
      ctx.userRoles?.includes(RoleName.SUPER_ADMIN);

    if (!isReviewer) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    const pending = await this.daftarService.listPendingReviews();
    if (pending.length === 0) {
      await ctx.reply('✅ Барча буюртмалар кўриб чиқилган, навбат бўш.');
      return;
    }

    let text = '📝 <b>Дафтар тасдиғи кутилаётган буюртмалар:</b>\n\n';
    const ik = new InlineKeyboard();

    for (const o of pending.slice(0, 5)) {
      text += `• <b>${o.orderNumber}</b> | ${o.customer.fullName} | Сотувчи: ${o.seller.firstName || ''}\n`;
      ik.text(`✅ Тасдиқлаш`, `review_daftar:${o.id}:${DaftarStatus.APPROVED}`)
        .text(`❌ Қайтариш`, `review_daftar:${o.id}:${DaftarStatus.NEEDS_CORRECTION}`)
        .row();
    }

    await ctx.reply(text, { reply_markup: ik, parse_mode: 'HTML' });
  }

  private async handleDebtsButton(ctx: BotContext) {
    const isOperator =
      ctx.userRoles?.includes(RoleName.CONTINUATION_OPERATOR) ||
      ctx.userRoles?.includes(RoleName.SUPER_ADMIN);

    if (!isOperator) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    const debts = await this.debtsService.listActiveDebts(ctx.user.id);
    if (debts.length === 0) {
      await ctx.reply('💳 Ҳозирча очиқ қарздорликлар мавжуд эмас.');
      return;
    }

    let text = '💳 <b>35-банд: Фаол қарздорликлар рўйхати:</b>\n\n';
    const ik = new InlineKeyboard();

    for (const d of debts.slice(0, 10)) {
      const dueStr = DateUtil.formatDateTashkent(d.debtDueDate);
      text +=
        `• <b>${d.order.orderNumber}</b> | Харидор: <b>${d.buyer.fullName}</b> (${d.buyer.phone})\n` +
        `  Қолдиқ қарз: <b>${DecimalUtil.formatMoney(d.remainingAmount)}</b> | Муддат: ${dueStr}\n\n`;

      ik.text(`💵 Тўлов қабул қилиш (${d.order.orderNumber})`, `debt_pay_start:${d.id}`).row();
    }

    text += `<i>Исталган қарздорлик бўйича тўлов қабул қилиш учун юқоридаги тугмалардан бирини босинг ёки буюртма рақамини ёзиб юборинг.</i>`;

    await ctx.reply(text, { reply_markup: ik, parse_mode: 'HTML' });
  }

  private async handleReportsButton(ctx: BotContext) {
    const isSuperAdmin = ctx.userRoles?.includes(RoleName.SUPER_ADMIN);
    if (!isSuperAdmin) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    const report = await this.reportsService.generateFinancialReport();
    const msg =
      `📊 <b>Молиявий ҳисобот:</b>\n\n` +
      `<b>Буюртмалар:</b> ${report.orders.totalOrders} та\n` +
      `Умумий прайс суммаси: ${report.orders.totalOrderPrice}\n\n` +
      `<b>Сотувлар:</b> ${report.sales.totalSales} та\n` +
      `Ҳақиқий келишилган савдо: ${report.sales.actualSalesTotal}\n` +
      `Очиқ қарздорлик: ${report.sales.totalOpenDebt}\n` +
      `Муддати ўтган қарздорлик: ${report.sales.totalOverdueDebt}\n\n` +
      `<b>Тўловлар:</b>\n` +
      `Сўмда: ${report.payments.uzsCashBank}\n` +
      `Долларда: ${report.payments.usdTotal}\n` +
      `Жами UZS эквиваленти: ${report.payments.totalCalculatedUzs}\n\n` +
      `Бекор қилинган тўловлар (Reversals): ${report.reversals.count} та (${report.reversals.totalReversedAmount})`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  }

  private async handleManagementButton(ctx: BotContext) {
    const isSuperAdmin = ctx.userRoles?.includes(RoleName.SUPER_ADMIN);
    if (!isSuperAdmin) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    const pendingUsers = await this.usersService.listPendingUsers();
    const admins = await this.usersService.listAdmins();

    const ik = new InlineKeyboard()
      .text('➕ Янги админ қўшиш (ID орқали)', 'mgmt_add_admin')
      .row()
      .text(`👑 Админлар (${admins.length})`, 'mgmt_list_admins')
      .text(`⏳ Кутилаётганлар (${pendingUsers.length})`, 'mgmt_pending')
      .row()
      .text('👥 Барча ходимлар', 'mgmt_list_staff')
      .text('📢 Чеклар гуруҳи', 'mgmt_receipts_group');

    await ctx.reply(
      `⚙️ <b>Бошқарув ва ходимлар панели:</b>\n\n` +
      `• Фаол админлар: <b>${admins.length} та</b>\n` +
      `• Тасдиқ кутилаётган ходимлар: <b>${pendingUsers.length} та</b>\n\n` +
      `Қуйидаги тугмалардан бирини танланг ёки тўғридан-тўғри буйруқ юборинг:\n` +
      `<code>/add_admin [TELEGRAM_ID]</code>`,
      { reply_markup: ik, parse_mode: 'HTML' },
    );
  }

  private async showHandoffOperators(ctx: BotContext, orderId: string) {
    const operators = await this.usersService.getContinuationOperators();
    if (operators.length === 0) {
      await ctx.reply('Тизимда фаол 2-босқич ходимлари топилмади.');
      return;
    }

    const ik = new InlineKeyboard();
    for (const op of operators) {
      ik.text(`👤 ${op.firstName || ''} ${op.lastName || ''}`, `assign_to:${orderId}:${op.id}`).row();
    }

    await ctx.reply('Илтимос, буюртмани қабул қиладиган операторни танланг:', { reply_markup: ik });
  }

  private async renderOrderCard(ctx: BotContext, orderId: string) {
    try {
      const order = await this.ordersService.getOrderById(orderId, ctx.user.id);
      const isSuperAdmin = ctx.userRoles?.includes(RoleName.SUPER_ADMIN);
      const isSeller = order.sellerId === ctx.user.id || isSuperAdmin;

      let msg =
        `📄 <b>Буюртма карточкаси: ${order.orderNumber}</b>\n` +
        `Ҳолат: <b>${order.status}</b>\n` +
        `Сана: ${DateUtil.formatTashkent(order.businessDate)}\n` +
        `Сотувчи: ${order.seller.firstName || ''} ${order.seller.lastName || ''}\n` +
        `Дастур: ${order.program.name}\n` +
        `Магазин: ${order.store.name}\n` +
        `Мижоз: ${order.customer.fullName} (${order.customer.phone1})\n` +
        `Умумий лимит: ${DecimalUtil.formatMoney(order.customer.generalLimit)}\n` +
        `Ечиладиган лимит: ${DecimalUtil.formatMoney(order.customer.withdrawableLimit)}\n` +
        `Клиентга бериладиган: ${DecimalUtil.formatMoney(order.clientPayoutAmount)}\n` +
        `Товарлар сони: ${order.totalQuantity} та\n` +
        `Прайс жами: ${DecimalUtil.formatMoney(order.totalPrice)}\n\n`;

      const latestReview = order.daftarReviews[0];
      const reviewStatus = latestReview?.status || 'PENDING';
      msg += `Дафтар тасдиғи: <b>${DAFTAR_STATUS_TEXTS[reviewStatus]}</b>\n`;

      const ik = new InlineKeyboard();

      // Show Stage 2 handoff button if ready
      if (
        order.program.requiresContinuation &&
        order.status === OrderStatus.READY_FOR_HANDOFF &&
        isSeller
      ) {
        ik.text('➡️ Буюртмани ўтказиш', `handoff_order:${order.id}`).row();
      }

      // Passport secure access link
      const passportAtt = order.attachments.find(
        (a) => a.type === 'PASSPORT_PHOTO',
      );
      if (passportAtt) {
        ik.text('🔒 Паспорт фотоси', `view_passport:${passportAtt.id}`).row();
      }

      await ctx.reply(msg, { reply_markup: ik, parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`Хатолик: ${(err as Error).message}`);
    }
  }

  // ===================== TRANSACTIONAL OUTBOX DISPATCHER =====================

  private async dispatchOutboxEvents() {
    const pendingEvents = await this.outboxService.getPendingEvents(15);
    for (const event of pendingEvents) {
      const payload: any = event.payload;
      try {
        const targetChatId = payload.recipientTelegramId || payload.chatId;
        if (targetChatId) {
          await this.bot.api.sendMessage(targetChatId, payload.message, {
            reply_markup: payload.replyMarkup,
            parse_mode: 'HTML',
          });
        }
        await this.outboxService.markSent(event.id);
      } catch (e) {
        await this.outboxService.markFailed(event.id, (e as Error).message);
      }
    }
  }
}
