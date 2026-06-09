import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { initTelegram, isTelegram, haptic } from "./telegram";
import { Onboarding } from "./screens/Onboarding";
import { Digest } from "./screens/Digest";
import { Settings } from "./screens/Settings";
import { Glass, Spinner } from "./components/ui";

type Tab = "tasks" | "settings";

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string>("");
  const [tab, setTab] = useState<Tab>("tasks");

  const load = useCallback(async () => {
    try {
      setMe(await api.me());
      setError("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось загрузиться");
    }
  }, []);

  useEffect(() => {
    initTelegram();
    if (isTelegram) void load();
  }, [load]);

  if (!isTelegram) {
    return (
      <Centered>
        <div className="brandmark">O</div>
        <div className="h2">Откройте Ovra в Telegram</div>
        <div className="faint center">
          Это приложение работает внутри Telegram. Запустите его кнопкой в боте.
        </div>
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <div className="muted center">{error}</div>
      </Centered>
    );
  }

  if (!me) return <Spinner />;

  // No workspace context (opened without the group's signed link).
  if (!me.tenant_id) {
    return (
      <Centered>
        <div className="brandmark">O</div>
        <div className="h2">Нет рабочей группы</div>
        <div className="faint center">
          Откройте Ovra кнопкой «Открыть приложение» из вашего рабочего чата, чтобы привязаться к доске.
        </div>
      </Centered>
    );
  }

  const onboarded = me.connected && me.board_resolved && me.linked;
  if (!onboarded) {
    return <Onboarding me={me} onDone={load} />;
  }

  return (
    <>
      <div className="app">
        {tab === "tasks" && <Digest tenant={me.tenant_id} />}
        {tab === "settings" && <Settings me={me} />}
      </div>

      <Glass pad={false} className="tabbar">
        <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} label="Задачи" icon={<IconTasks />} />
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")} label="Настройки" icon={<IconGear />} />
      </Glass>
    </>
  );
}

function TabButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      className={`tab ${active ? "active" : ""}`}
      onClick={() => {
        haptic();
        onClick();
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="app" style={{ justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <div className="stack-sm center fade-in" style={{ alignItems: "center", maxWidth: 320 }}>
        {children}
      </div>
    </div>
  );
}

function IconTasks() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
