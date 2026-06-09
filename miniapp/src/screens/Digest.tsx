import { useEffect, useState } from "react";
import { api, type Digest as DigestData, type DigestTask } from "../api";
import { Avatar, Glass, Spinner, StatusDot } from "../components/ui";

const STATUS_LABEL: Record<string, string> = {
  todo: "В очереди",
  in_progress: "В работе",
  review: "На ревью",
  done: "Готово",
};

export function Digest({ tenant }: { tenant: string }) {
  const [data, setData] = useState<DigestData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api
      .digest(tenant)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [tenant]);

  if (err) return <Centered emoji="⚠️" text={err} />;
  if (!data) return <Spinner />;

  const total =
    data.assignees.reduce((s, a) => s + a.tasks.length, 0) + (data.unassigned?.length ?? 0);

  if (total === 0) return <Centered emoji="🎉" text="Открытых задач нет — всё чисто!" />;

  return (
    <div className="stack fade-in">
      <div className="spread">
        <div className="h1">Задачи</div>
        <span className="pill">{total} открытых</span>
      </div>

      {data.assignees.map((a) => (
        <Glass key={a.full_name + a.tg_username}>
          <div className="spread" style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Avatar name={a.full_name} />
              <div>
                <div style={{ fontWeight: 650 }}>{a.full_name}</div>
                {a.tg_username && <div className="faint">{a.tg_username}</div>}
              </div>
            </div>
            <span className="pill">{a.tasks.length}</span>
          </div>
          <div className="stack-sm">
            {a.tasks.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </div>
        </Glass>
      ))}

      {data.unassigned?.length > 0 && (
        <Glass>
          <div className="spread" style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 650 }}>❓ Без исполнителя</div>
            <span className="pill">{data.unassigned.length}</span>
          </div>
          <div className="stack-sm">
            {data.unassigned.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </div>
        </Glass>
      )}
    </div>
  );
}

function TaskRow({ t }: { t: DigestTask }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "4px 0" }}>
      <StatusDot status={t.status} />
      <div className="grow" style={{ flex: 1, minWidth: 0 }}>
        <div className="title" style={{ fontSize: 15 }}>
          {t.title}
        </div>
        <div className="faint">{STATUS_LABEL[t.status] ?? t.status}</div>
      </div>
      {t.deadline && (
        <span className="pill" style={{ color: t.overdue ? "var(--bad)" : "var(--ink-dim)" }}>
          {t.overdue ? "🔴" : "📅"} {new Date(t.deadline).toLocaleDateString("ru-RU")}
        </span>
      )}
    </div>
  );
}

function Centered({ emoji, text }: { emoji: string; text: string }) {
  return (
    <div className="center stack-sm fade-in" style={{ padding: "80px 0", alignItems: "center" }}>
      <div style={{ fontSize: 52 }}>{emoji}</div>
      <div className="muted">{text}</div>
    </div>
  );
}
