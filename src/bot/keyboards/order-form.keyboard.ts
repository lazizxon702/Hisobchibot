import { Keyboard } from 'grammy';
import { FORM_ACTIONS } from '../../common/constants';

export function getFormControlsKeyboard(): Keyboard {
  return new Keyboard()
    .text(FORM_ACTIONS.back)
    .text(FORM_ACTIONS.saveDraft)
    .row()
    .text(FORM_ACTIONS.continueLater)
    .text(FORM_ACTIONS.cancel)
    .resized();
}

export function getFormReviewKeyboard(): Keyboard {
  return new Keyboard()
    .text(FORM_ACTIONS.confirm)
    .text(FORM_ACTIONS.edit)
    .row()
    .text(FORM_ACTIONS.saveDraft)
    .text(FORM_ACTIONS.cancel)
    .resized();
}

export function getCancelConfirmationKeyboard(): Keyboard {
  return new Keyboard()
    .text('Ҳа, бекор қилиш')
    .text('Йўқ, давом этиш')
    .resized();
}
