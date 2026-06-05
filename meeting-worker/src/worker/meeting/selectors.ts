// Telemost UI selectors verified against live UI on 2026-06-05.
// All data-testid values confirmed by live DOM inspection.

export const SELECTORS = {
  // Interstitial "open in app vs browser" page shown before the lobby.
  continueInBrowser: [
    'button:has-text("Продолжить в браузере")',
    'button:has-text("Continue in browser")',
  ],

  // Lobby: name input (guest flow). Default value is "Гость" — we overwrite it.
  nameInput: [
    '[data-testid="orb-textinput-input"]',
    'input[type="text"]',
  ],

  // Lobby: join button. Disappears once inside the room.
  joinButton: [
    '[data-testid="enter-conference-button"]',
    'button:has-text("Подключиться")',
    'button:has-text("Join")',
  ],

  // In-call: present only inside the room (not in lobby).
  // Using the red leave button — it only renders after joining.
  inCallIndicator: [
    '[data-testid="end-call-alt-button"]',
    '[aria-label="Выйти из встречи"]',
    '[data-testid="mute-audio"]',
  ],

  // In-call: leave / end call button (red button bottom-right).
  leaveButton: [
    '[data-testid="end-call-alt-button"]',
    '[aria-label="Выйти из встречи"]',
    'button:has-text("Завершить")',
    'button:has-text("Покинуть")',
  ],
} as const;

// Texts that appear in document.body.innerText when the call has ended.
export const CALL_ENDED_TEXTS = [
  "Звонок завершён",
  "Звонок завершен",
  "Встреча завершена",
  "Вас удалили",
  "You have been removed",
  "The call has ended",
];
