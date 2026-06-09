// Thin typed wrapper over the global Telegram WebApp object injected by
// telegram-web-app.js. We read initData (the signed string) here once and hand
// it to the API layer; the backend re-verifies its signature on every request.

interface TgWebApp {
  initData: string;
  initDataUnsafe: {
    user?: { id: number; first_name?: string; username?: string };
    start_param?: string;
  };
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
  MainButton: {
    setText(t: string): void;
    show(): void;
    hide(): void;
    enable(): void;
    disable(): void;
    showProgress(leave?: boolean): void;
    hideProgress(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg: TgWebApp | undefined = window.Telegram?.WebApp;

// Raw signed initData sent to the backend as `Authorization: tma <initData>`.
export const initData = tg?.initData ?? "";

export function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  tg.setHeaderColor?.("#070b1c");
  tg.setBackgroundColor?.("#070b1c");
}

export function haptic(kind: "light" | "medium" | "heavy" = "light") {
  tg?.HapticFeedback?.impactOccurred(kind);
}

export function notify(kind: "error" | "success" | "warning") {
  tg?.HapticFeedback?.notificationOccurred(kind);
}

// During local browser development there is no Telegram context. We surface that
// clearly instead of failing silently with an empty initData.
export const isTelegram = Boolean(tg && initData);
