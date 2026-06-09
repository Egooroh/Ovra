import { useEffect, useState } from "react";
import { api, type CalendarAccount, type Me } from "../api";
import { haptic, notify } from "../telegram";
import { Button, Glass, Spinner } from "../components/ui";

export function Settings({ me }: { me: Me }) {
  const isHost = me.role === "host";
  return (
    <div className="stack fade-in">
      <div className="h1">Настройки</div>

      <Glass>
        <div className="spread">
          <div>
            <div className="h2">{me.workspace_name || "Воркспейс"}</div>
            <div className="faint">
              {me.connected ? "✅ YouGile подключён" : "⚠️ YouGile не подключён"}
              {me.board_resolved ? " · доска готова" : ""}
            </div>
          </div>
          <span className="pill">{roleLabel(me.role)}</span>
        </div>
      </Glass>

      {isHost ? (
        <>
          <DigestSettings me={me} />
          <CalendarSettings me={me} />
        </>
      ) : (
        <Glass>
          <div className="muted">
            Настройки доски и календаря доступны администратору воркспейса.
          </div>
        </Glass>
      )}
    </div>
  );
}

function roleLabel(r: string) {
  return r === "host" ? "Админ" : r === "member" ? "Участник" : "Гость";
}

function DigestSettings({ me }: { me: Me }) {
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("10:00");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      await api.updateDigest(me.tenant_id, enabled, time);
      notify("success");
      setSaved(true);
    } catch {
      notify("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Glass>
      <div className="h2" style={{ marginBottom: 12 }}>
        📬 Ежедневный дайджест
      </div>
      <div className="stack-sm">
        <Toggle
          label="Присылать дайджест в чат"
          on={enabled}
          onToggle={() => {
            haptic();
            setEnabled((v) => !v);
          }}
        />
        {enabled && (
          <label>
            <span className="label">Время отправки</span>
            <input
              className="field"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        )}
        <Button variant="ghost" onClick={save} loading={busy}>
          {saved ? "Сохранено ✓" : "Сохранить"}
        </Button>
      </div>
    </Glass>
  );
}

function CalendarSettings({ me }: { me: Me }) {
  const [accounts, setAccounts] = useState<CalendarAccount[] | null>(null);

  function reload() {
    api
      .calendarAccounts(me.tenant_id)
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }
  useEffect(reload, [me.tenant_id]);

  async function remove(id: string) {
    await api.deleteCalendar(me.tenant_id, id);
    notify("success");
    reload();
  }

  return (
    <Glass>
      <div className="h2" style={{ marginBottom: 6 }}>
        📅 Календари
      </div>
      <div className="faint" style={{ marginBottom: 12 }}>
        Бот заходит на Telemost-звонки из календаря и присылает саммари.
      </div>
      {accounts === null ? (
        <Spinner />
      ) : accounts.length === 0 ? (
        <div className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
          Подключённых календарей нет.
        </div>
      ) : (
        <div className="stack-sm" style={{ marginBottom: 12 }}>
          {accounts.map((a) => (
            <div key={a.id} className="row" style={{ cursor: "default" }}>
              <div className="avatar">{a.provider === "google" ? "🔵" : "🟡"}</div>
              <div className="grow">
                <div className="title">
                  {a.label || (a.provider === "google" ? "Google Calendar" : "Яндекс Календарь")}
                </div>
                <div className="faint">{a.active ? "активен" : "выключен"}</div>
              </div>
              <button
                onClick={() => remove(a.id)}
                style={{ background: "none", border: 0, color: "var(--bad)", cursor: "pointer", fontSize: 18 }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="faint">
        Добавление календаря пока через бота: команда <b>/calendar</b> в группе.
      </div>
    </Glass>
  );
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="spread">
      <span style={{ fontSize: 15 }}>{label}</span>
      <button
        onClick={onToggle}
        style={{
          width: 52,
          height: 30,
          borderRadius: 99,
          border: 0,
          cursor: "pointer",
          position: "relative",
          background: on
            ? "linear-gradient(150deg, var(--brand-400), var(--brand))"
            : "rgba(255,255,255,0.18)",
          transition: "background .2s ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: on ? 25 : 3,
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .2s ease",
            boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
          }}
        />
      </button>
    </div>
  );
}
