import { Keyboard } from 'grammy';
import { RoleName } from '@prisma/client';
import { MENU_BUTTONS } from '../../common/constants';

export function getMainMenuKeyboard(roles: RoleName[]): Keyboard {
  const kb = new Keyboard();
  const isSuperAdmin = roles.includes(RoleName.SUPER_ADMIN);
  const isSeller = roles.includes(RoleName.SELLER) || isSuperAdmin;
  const isOperator = roles.includes(RoleName.CONTINUATION_OPERATOR) || isSuperAdmin;
  const isReviewer = roles.includes(RoleName.DAFTAR_REVIEWER) || isSuperAdmin;

  let rowCount = 0;

  if (isSeller) {
    kb.text(MENU_BUTTONS.newOrder);
    kb.text(MENU_BUTTONS.drafts);
    kb.row();
  }

  kb.text(MENU_BUTTONS.myOrders);

  if (isOperator) {
    kb.text(MENU_BUTTONS.incomingQueue);
    kb.row();
  } else {
    kb.row();
  }

  if (isReviewer) {
    kb.text(MENU_BUTTONS.daftarReview);
  }

  kb.text(MENU_BUTTONS.inventory);
  kb.row();

  if (isOperator) {
    kb.text(MENU_BUTTONS.debts);
  }

  kb.text(MENU_BUTTONS.search);
  kb.row();

  if (isSuperAdmin) {
    kb.text(MENU_BUTTONS.reports);
    kb.text(MENU_BUTTONS.management);
    kb.row();
  }

  return kb.resized();
}
