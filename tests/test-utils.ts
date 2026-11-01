import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { SequenceService } from '../src/infrastructure/sequence/sequence.service';
import { StorageService } from '../src/infrastructure/storage/storage.service';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { UsersService } from '../src/modules/users/users.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { FinancingProgramsService } from '../src/modules/financing-programs/financing-programs.service';
import { StoresService } from '../src/modules/stores/stores.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { DaftarService } from '../src/modules/daftar/daftar.service';
import { AssignmentsService } from '../src/modules/assignments/assignments.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { DebtsService } from '../src/modules/debts/debts.service';
import { AttachmentsService } from '../src/modules/attachments/attachments.service';
import { RemindersService } from '../src/modules/reminders/reminders.service';

export interface InMemoryDb {
  users: any[];
  roles: any[];
  userRoles: any[];
  programs: any[];
  stores: any[];
  customers: any[];
  buyers: any[];
  orders: any[];
  orderDrafts: any[];
  orderItems: any[];
  inventoryUnits: any[];
  orderAssignments: any[];
  daftarReviews: any[];
  sales: any[];
  saleItems: any[];
  payments: any[];
  paymentReversals: any[];
  debtSchedules: any[];
  reminders: any[];
  attachments: any[];
  auditEvents: any[];
  outboxEvents: any[];
  processedUpdates: any[];
}

export function createInMemoryDb(): InMemoryDb {
  return {
    users: [],
    roles: [],
    userRoles: [],
    programs: [],
    stores: [],
    customers: [],
    buyers: [],
    orders: [],
    orderDrafts: [],
    orderItems: [],
    inventoryUnits: [],
    orderAssignments: [],
    daftarReviews: [],
    sales: [],
    saleItems: [],
    payments: [],
    paymentReversals: [],
    debtSchedules: [],
    reminders: [],
    attachments: [],
    auditEvents: [],
    outboxEvents: [],
    processedUpdates: [],
  };
}

export function createMockPrismaService(db: InMemoryDb): PrismaService {
  let seqCounter = 1;

  const mock: any = {
    $transaction: async (fn: any) => {
      return await fn(mock);
    },
    $queryRawUnsafe: async (query: string, name: string) => {
      return [{ currentValue: BigInt(seqCounter++) }];
    },
    $queryRaw: async () => [{ 1: 1 }],

    user: {
      findUnique: async ({ where }: any) => {
        if (where.id) return db.users.find((u) => u.id === where.id) || null;
        if (where.telegramId !== undefined)
          return db.users.find((u) => u.telegramId.toString() === where.telegramId.toString()) || null;
        return null;
      },
      findFirst: async ({ where }: any) => {
        return db.users[0] || null;
      },
      findMany: async (args: any) => db.users,
      create: async ({ data }: any) => {
        const item = { id: `user-${Date.now()}-${Math.random()}`, roles: [], ...data };
        db.users.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.users.find((u) => u.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    role: {
      findUnique: async ({ where }: any) => {
        return db.roles.find((r) => r.name === where.name) || null;
      },
      upsert: async ({ where, create }: any) => {
        let r = db.roles.find((item) => item.name === where.name);
        if (!r) {
          r = { id: `role-${Date.now()}`, ...create };
          db.roles.push(r);
        }
        return r;
      },
    },

    userRole: {
      create: async ({ data }: any) => {
        db.userRoles.push(data);
        const user = db.users.find((u) => u.id === data.userId);
        const role = db.roles.find((r) => r.id === data.roleId);
        if (user && role) {
          user.roles = user.roles || [];
          user.roles.push({ userId: user.id, roleId: role.id, role });
        }
        return data;
      },
      deleteMany: async ({ where }: any) => {
        db.userRoles = db.userRoles.filter((ur) => ur.userId !== where.userId);
        const user = db.users.find((u) => u.id === where.userId);
        if (user) user.roles = [];
      },
    },

    financingProgram: {
      findUnique: async ({ where }: any) => {
        return db.programs.find((p) => p.id === where.id || p.name === where.name) || null;
      },
      findMany: async () => db.programs,
      create: async ({ data }: any) => {
        const item = { id: `prog-${Date.now()}-${Math.random()}`, ...data };
        db.programs.push(item);
        return item;
      },
    },

    store: {
      findUnique: async ({ where }: any) => {
        return db.stores.find((s) => s.id === where.id) || null;
      },
      findMany: async () => db.stores,
      create: async ({ data }: any) => {
        const item = { id: `store-${Date.now()}-${Math.random()}`, ...data };
        db.stores.push(item);
        return item;
      },
    },

    customer: {
      findFirst: async ({ where }: any) => {
        return db.customers.find((c) => c.phone1 === where.phone1) || null;
      },
      create: async ({ data }: any) => {
        const item = { id: `cust-${Date.now()}-${Math.random()}`, ...data };
        db.customers.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.customers.find((c) => c.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    buyer: {
      findFirst: async ({ where }: any) => {
        return db.buyers.find((b) => b.phone === where.phone) || null;
      },
      create: async ({ data }: any) => {
        const item = { id: `buyer-${Date.now()}-${Math.random()}`, ...data };
        db.buyers.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.buyers.find((b) => b.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    attachment: {
      findUnique: async ({ where }: any) => {
        return db.attachments.find((a) => a.id === where.id) || null;
      },
      findMany: async ({ where }: any) => {
        if (where?.id?.in) {
          return db.attachments.filter((a) => where.id.in.includes(a.id));
        }
        return db.attachments;
      },
      create: async ({ data }: any) => {
        const item = { id: `att-${Date.now()}-${Math.random()}`, ...data };
        db.attachments.push(item);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        if (where?.id?.in) {
          for (const a of db.attachments) {
            if (where.id.in.includes(a.id)) Object.assign(a, data);
          }
        }
      },
      update: async ({ where, data }: any) => {
        const item = db.attachments.find((a) => a.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    order: {
      findUnique: async ({ where }: any) => {
        const order = db.orders.find((o) => o.id === where.id || o.orderNumber === where.orderNumber);
        if (!order) return null;
        return {
          ...order,
          seller: db.users.find((u) => u.id === order.sellerId),
          customer: db.customers.find((c) => c.id === order.customerId),
          program: db.programs.find((p) => p.id === order.programId),
          store: db.stores.find((s) => s.id === order.storeId),
          items: db.orderItems.filter((i) => i.orderId === order.id),
          inventoryUnits: db.inventoryUnits.filter((u) => u.orderId === order.id),
          assignments: db.orderAssignments
            .filter((a) => a.orderId === order.id)
            .map((a) => ({ ...a, operator: db.users.find((u) => u.id === a.operatorId) })),
          daftarReviews: db.daftarReviews
            .filter((d) => d.orderId === order.id)
            .slice()
            .reverse(),
          attachments: db.attachments.filter((a) => a.orderId === order.id),
          sales: db.sales.filter((s) => s.orderId === order.id),
        };
      },
      findUniqueOrThrow: async (args: any) => {
        const res = await mock.order.findUnique(args);
        if (!res) throw new Error('Order not found');
        return res;
      },
      findMany: async (args: any) => {
        return db.orders.map((o) => ({
          ...o,
          customer: db.customers.find((c) => c.id === o.customerId),
          program: db.programs.find((p) => p.id === o.programId),
          seller: db.users.find((u) => u.id === o.sellerId),
          assignments: db.orderAssignments.filter((a) => a.orderId === o.id),
        }));
      },
      create: async ({ data }: any) => {
        const item = { id: `order-${Date.now()}-${Math.random()}`, version: 1, ...data };
        db.orders.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.orders.find((o) => o.id === where.id);
        if (item) {
          if (data.version?.increment) {
            item.version = (item.version || 1) + 1;
            delete data.version;
          }
          Object.assign(item, data);
        }
        return item;
      },
    },

    orderDraft: {
      findUnique: async ({ where }: any) => {
        return db.orderDrafts.find((d) => d.userId === where.userId) || null;
      },
      upsert: async ({ where, create, update }: any) => {
        let d = db.orderDrafts.find((item) => item.userId === where.userId);
        if (d) {
          Object.assign(d, update);
        } else {
          d = { id: `draft-${Date.now()}`, ...create, updatedAt: new Date() };
          db.orderDrafts.push(d);
        }
        return d;
      },
      deleteMany: async ({ where }: any) => {
        db.orderDrafts = db.orderDrafts.filter((d) => d.userId !== where.userId);
      },
    },

    orderItem: {
      create: async ({ data }: any) => {
        const item = { id: `item-${Date.now()}-${Math.random()}`, ...data };
        db.orderItems.push(item);
        return item;
      },
    },

    inventoryUnit: {
      findUnique: async ({ where }: any) => {
        return db.inventoryUnits.find((u) => u.id === where.id) || null;
      },
      findFirst: async ({ where }: any) => {
        if (where.imei1) return db.inventoryUnits.find((u) => u.imei1 === where.imei1) || null;
        return null;
      },
      findMany: async ({ where }: any) => {
        if (where?.id?.in) {
          return db.inventoryUnits.filter((u) => where.id.in.includes(u.id));
        }
        if (where?.orderId) {
          return db.inventoryUnits.filter((u) => u.orderId === where.orderId);
        }
        return db.inventoryUnits;
      },
      create: async ({ data }: any) => {
        const item = { id: `unit-${Date.now()}-${Math.random()}`, ...data };
        db.inventoryUnits.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.inventoryUnits.find((u) => u.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    orderAssignment: {
      findFirst: async ({ where }: any) => {
        return (
          db.orderAssignments.find(
            (a) =>
              a.orderId === where.orderId &&
              (!where.operatorId || a.operatorId === where.operatorId) &&
              (!where.status || a.status === where.status),
          ) || null
        );
      },
      create: async ({ data }: any) => {
        const item = { id: `asgn-${Date.now()}-${Math.random()}`, ...data };
        db.orderAssignments.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.orderAssignments.find((a) => a.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
      deleteMany: async ({ where }: any) => {
        db.orderAssignments = db.orderAssignments.filter(
          (a) => !(a.orderId === where.orderId && a.status === where.status),
        );
      },
    },

    daftarReview: {
      create: async ({ data }: any) => {
        const item = { id: `rev-${Date.now()}-${Math.random()}`, createdAt: new Date(), ...data };
        db.daftarReviews.push(item);
        return item;
      },
    },

    sale: {
      findUnique: async ({ where }: any) => {
        const sale = db.sales.find((s) => s.id === where.id);
        if (!sale) return null;
        const ord = db.orders.find((o) => o.id === sale.orderId);
        return {
          ...sale,
          order: ord ? { ...ord, assignments: db.orderAssignments.filter((a) => a.orderId === ord.id) } : null,
          buyer: db.buyers.find((b) => b.id === sale.buyerId),
          payments: db.payments
            .filter((p) => p.saleId === sale.id)
            .map((p) => ({ ...p, reversal: db.paymentReversals.find((r) => r.paymentId === p.id) })),
          items: db.saleItems.filter((i) => i.saleId === sale.id),
          debtSchedules: db.debtSchedules.filter((d) => d.saleId === sale.id),
        };
      },
      findUniqueOrThrow: async (args: any) => {
        const res = await mock.sale.findUnique(args);
        if (!res) throw new Error('Sale not found');
        return res;
      },
      findMany: async () => db.sales,
      create: async ({ data }: any) => {
        const item = { id: `sale-${Date.now()}-${Math.random()}`, version: 1, ...data };
        db.sales.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.sales.find((s) => s.id === where.id);
        if (item) {
          if (data.version?.increment) {
            item.version = (item.version || 1) + 1;
            delete data.version;
          }
          Object.assign(item, data);
        }
        return item;
      },
    },

    saleItem: {
      create: async ({ data }: any) => {
        const item = { id: `sitem-${Date.now()}-${Math.random()}`, ...data };
        db.saleItems.push(item);
        return item;
      },
    },

    payment: {
      findUnique: async ({ where }: any) => {
        const p = db.payments.find((x) => x.id === where.id || x.receiptNumber === where.receiptNumber);
        if (!p) return null;
        return {
          ...p,
          sale: db.sales.find((s) => s.id === p.saleId),
          reversal: db.paymentReversals.find((r) => r.paymentId === p.id),
        };
      },
      findMany: async ({ where }: any) => {
        let res = db.payments;
        if (where?.saleId) res = res.filter((p) => p.saleId === where.saleId);
        if (where?.status) res = res.filter((p) => p.status === where.status);
        return res;
      },
      create: async ({ data }: any) => {
        const item = { id: `pay-${Date.now()}-${Math.random()}`, ...data };
        db.payments.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.payments.find((p) => p.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    paymentReversal: {
      create: async ({ data }: any) => {
        const item = { id: `rev-${Date.now()}-${Math.random()}`, ...data };
        db.paymentReversals.push(item);
        return item;
      },
      findMany: async () => db.paymentReversals,
    },

    debtSchedule: {
      findFirst: async ({ where }: any) => {
        return db.debtSchedules.find((d) => d.saleId === where.saleId && d.isSettled === where.isSettled) || null;
      },
      findMany: async ({ where }: any) => {
        return db.debtSchedules.filter((d) => !where?.saleId || d.saleId === where.saleId);
      },
      create: async ({ data }: any) => {
        const item = { id: `ds-${Date.now()}-${Math.random()}`, ...data };
        db.debtSchedules.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.debtSchedules.find((d) => d.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        for (const ds of db.debtSchedules) {
          if (where.saleId && ds.saleId !== where.saleId) continue;
          if (where.isSettled !== undefined && ds.isSettled !== where.isSettled) continue;
          Object.assign(ds, data);
        }
      },
    },

    reminder: {
      findMany: async () => db.reminders,
      create: async ({ data }: any) => {
        const item = { id: `rem-${Date.now()}-${Math.random()}`, isCancelled: false, ...data };
        db.reminders.push(item);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        for (const r of db.reminders) {
          if (where.saleId && r.saleId !== where.saleId) continue;
          Object.assign(r, data);
        }
      },
    },

    auditEvent: {
      create: async ({ data }: any) => {
        db.auditEvents.push(data);
        return data;
      },
      findMany: async () => db.auditEvents,
    },

    outboxEvent: {
      create: async ({ data }: any) => {
        const item = { id: `outbox-${Date.now()}-${Math.random()}`, attempts: 0, ...data };
        db.outboxEvents.push(item);
        return item;
      },
      findMany: async () => db.outboxEvents,
      findUnique: async ({ where }: any) => db.outboxEvents.find((e) => e.id === where.id) || null,
      update: async ({ where, data }: any) => {
        const item = db.outboxEvents.find((e) => e.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      },
    },

    processedTelegramUpdate: {
      findUnique: async ({ where }: any) => {
        return db.processedUpdates.find((u) => u.updateId.toString() === where.updateId.toString()) || null;
      },
      create: async ({ data }: any) => {
        db.processedUpdates.push(data);
        return data;
      },
    },
  };

  return mock as PrismaService;
}
