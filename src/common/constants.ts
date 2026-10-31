export const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Tashkent';

export const BOT_TEXTS = {
  welcome: 'Ассалому алайкум! «Ҳисобчи» муддатли тўлов ва савдо бошқарув тизимига хуш келибсиз.',
  unauthorized: 'Кечирасиз, сиз ҳали тизимдан рўйхатдан ўтмагансиз ёки администратор томонидан тасдиқланмагансиз.\nИлтимос, Telegram ID’нгизни администраторга тақдим этинг: ',
  pendingApproval: 'Сизнинг сўровингиз кўриб чиқилмоқда. Администратор тасдиқлашини кутинг.',
  accessDenied: 'Кечирасиз, сизга ушбу амални бажариш учун рухсат берилмаган.',
  orderCreated: 'Янги буюртма муваффақиятли яратилди!',
  orderNotFound: 'Буюртма топилмади ёки сизга уни кўришга рухсат йўқ.',
  paymentRecorded: 'Тўлов муваффақиятли қабул қилинди!',
  reversalSuccess: 'Тўлов муваффақиятли бекор қилинди (reversal)!',
};

export const MENU_BUTTONS = {
  newOrder: '➕ Янги буюртма',
  drafts: '📝 Қораламалар',
  myOrders: '📋 Менинг буюртмаларим',
  incomingQueue: '📥 Қабул қилиш навбати',
  daftarReview: '✅ Дафтар тасдиғи',
  inventory: '📦 Товарлар',
  debts: '💳 Қарздорликлар',
  search: '🔎 ID / чек рақами бўйича қидириш',
  reports: '📊 Ҳисоботлар',
  management: '⚙️ Бошқарув',
};

export const FORM_ACTIONS = {
  back: '◀️ Орқага',
  saveDraft: '💾 Қораламани сақлаш',
  continueLater: '⏸ Кейин давом эттириш',
  cancel: '❌ Бекор қилиш',
  review: '👁 Кўриб чиқиш',
  edit: '✏️ Таҳрирлаш',
  confirm: '✅ Тасдиқлаш',
};

export const DAFTAR_STATUS_TEXTS = {
  PENDING: 'В ожидании',
  NEEDS_CORRECTION: 'Надо исправить',
  APPROVED: 'Подтверждено',
  NOT_REQUIRED: 'Не требуется',
};

export const INVENTORY_STATUS_TEXTS = {
  IN_STOCK: 'На складе',
  SOLD: 'Продано',
  IN_TRANSIT: 'В пути',
  EXPECTED: 'Ожидается',
};

export const PAYMENT_STATUS_TEXTS = {
  PAID: 'Оплачено',
  PARTIAL: 'Частично',
  DEBT: 'Долг (Дебит)',
};
