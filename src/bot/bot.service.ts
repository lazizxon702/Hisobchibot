import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Bot, Context, InlineKeyboard } from 'grammy';
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
import { DecimalUtil } from '../common/decimal.util';
import { DateUtil } from '../common/date.util';
import { RoleName, OrderStatus, DaftarStatus, InventoryUnitStatus, AttachmentType } from '@prisma/client';
import { Decimal } from 'decimal.js';

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
  ) {
    const token =
      process.env.BOT_TOKEN || '9167571167:AAG9nOKq8IoKV0h8wfl2xKSeXhoYYiwppz0';
    this.bot = new Bot<BotContext>(token);
  }

  async onModuleInit() {
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
      const roles: RoleName[] = ctx.userRoles || [];
      const kb = getMainMenuKeyboard(roles);
      await ctx.reply(
        `${BOT_TEXTS.welcome}\n\nСизнинг профилингиз: <b>${ctx.user.firstName || ''} ${ctx.user.lastName || ''}</b>\nРоллар: <i>${roles.join(', ') || 'Ходим'}</i>`,
        { reply_markup: kb, parse_mode: 'HTML' },
      );
    });

    // Main menu buttons routing
    this.bot.hears(MENU_BUTTONS.newOrder, async (ctx) => {
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
        } else if (data.startsWith('select_prog:')) {
          const programId = data.split(':')[1];
          const program = await this.programsService.getById(programId);
          await this.ordersService.saveDraft(ctx.user.id, 'SELECT_STORE', { programId });

          const stores = await this.storesService.list();
          const ik = new InlineKeyboard();
          for (const s of stores) {
            ik.text(`🏪 ${s.name}`, `select_store:${s.id}`).row();
          }

          await ctx.reply(
            `✅ Дастур танланди: <b>${program.name}</b>\n\n` +
            `<b>2-босқич:</b> Савдо филиали / дўконни танланг:`,
            { reply_markup: ik, parse_mode: 'HTML' },
          );
        } else if (data.startsWith('select_store:')) {
          const storeId = data.split(':')[1];
          const store = await this.storesService.getById(storeId);
          const draft = await this.ordersService.getDraft(ctx.user.id);
          const currentData = (draft?.formData as any) || {};
          await this.ordersService.saveDraft(ctx.user.id, 'INPUT_CUSTOMER', {
            ...currentData,
            storeId,
          });

          await ctx.reply(
            `✅ Дўкон танланди: <b>${store.name}</b>\n\n` +
            `<b>3-босқич: Мижоз маълумотлари ва лимитларни киритиш.</b>\n\n` +
            `Қуйидаги форматда хабар юборинг:\n` +
            `<code>/client [Ф.И.Ш] [Тел] [Умумий лимит] [Ечиладиган лимит] [Шартнома тугаш санаси]</code>\n\n` +
            `<i>Эслатма: Ечиладиган лимит умумий лимитдан ошмаслиги шарт!</i>\n\n` +
            `Мисол:\n` +
            `<code>/client Алишер Каримов +998901234567 15000000 12000000 31.12.2026</code>`,
            { parse_mode: 'HTML' },
          );
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

  // ===================== BUTTON HANDLERS =====================

  private async handleNewOrderButton(ctx: BotContext) {
    // Check role: SELLER or SUPER_ADMIN
    const isSeller =
      ctx.userRoles?.includes(RoleName.SELLER) ||
      ctx.userRoles?.includes(RoleName.SUPER_ADMIN);

    if (!isSeller) {
      await ctx.reply(BOT_TEXTS.accessDenied);
      return;
    }

    // Check existing draft
    const draft = await this.ordersService.getDraft(ctx.user.id);
    if (draft) {
      await ctx.reply(
        `Сизда сақланган қоралама буюртма мавжуд (босқич: ${draft.step}). Давом эттирасизми ёки янгидан бошлайсизми?`,
        {
          reply_markup: new InlineKeyboard()
            .text('▶️ Давом эттириш', `resume_draft:${draft.id}`)
            .text('🗑 Янгидан бошлаш', `discard_draft:${draft.id}`),
        },
      );
      return;
    }

    const programs = await this.programsService.listActive();
    const ik = new InlineKeyboard();
    for (const p of programs) {
      ik.text(`🏦 ${p.name}`, `select_prog:${p.id}`).row();
    }

    await ctx.reply(
      '📝 <b>Янги буюртма очиш (1–20-бандлар):</b>\n\n' +
      '<b>1-босқич:</b> Муддатли тўлов дастурини танланг:\n' +
      '<i>(Қуйидаги тугмалардан бирини босинг)</i>',
      { reply_markup: ik, parse_mode: 'HTML' },
    );
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

    let text = '📋 <b>Сизнинг буюртмаларингиз:</b>\n\n';
    const ik = new InlineKeyboard();

    for (const o of orders.slice(0, 10)) {
      text += `• <b>${o.orderNumber}</b> | ${o.customer.fullName} | ${o.status}\n  Сумма: ${DecimalUtil.formatMoney(o.totalPrice)}\n\n`;
      ik.text(`📄 ${o.orderNumber}`, `view_order:${o.id}`).row();
    }

    await ctx.reply(text, { reply_markup: ik, parse_mode: 'HTML' });
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

    let text = '💳 <b>Фаол қарздорликлар рўйхати:</b>\n\n';
    for (const d of debts.slice(0, 10)) {
      const dueStr = DateUtil.formatDateTashkent(d.debtDueDate);
      text += `• <b>${d.order.orderNumber}</b> | Харидор: ${d.buyer.fullName}\n  Қолдиқ қарз: <b>${DecimalUtil.formatMoney(d.remainingAmount)}</b>\n  Муддат: ${dueStr}\n\n`;
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
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
