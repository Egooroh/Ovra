import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Me, type YougileProject, type YougileUser } from "../api";
import { haptic, notify } from "../telegram";
import { Avatar, Button, Field, Glass, Spinner, StepDots } from "../components/ui";

// The wizard derives its current step from the workspace state in `me`:
//   1. connect YouGile (host)   2. pick project (host)   3. pick yourself (all)
// A non-host opening a half-configured board is told to wait for the admin.

type Props = { me: Me; onDone: () => void };

export function Onboarding({ me, onDone }: Props) {
  const isHost = me.role === "host";

  const step = useMemo(() => {
    if (!me.connected) return 0;
    if (!me.board_resolved) return 1;
    return 2;
  }, [me]);

  return (
    <div className="app fade-in">
      <div className="center stack-sm" style={{ alignItems: "center", marginTop: 8 }}>
        <div className="brandmark">O</div>
        <div className="h1">Ovra</div>
        <div className="faint">Поручения из чата → задачи в YouGile</div>
      </div>

      <Glass>
        <div style={{ marginBottom: 16 }}>
          <StepDots total={3} current={step} />
        </div>
        {step === 0 &&
          (isHost ? (
            <ConnectStep me={me} onDone={onDone} />
          ) : (
            <WaitForAdmin text="Администратор ещё не подключил доску YouGile. Загляните позже." />
          ))}
        {step === 1 &&
          (isHost ? (
            <ProjectStep me={me} onDone={onDone} />
          ) : (
            <WaitForAdmin text="Администратор подключает проект. Осталось чуть-чуть." />
          ))}
        {step === 2 && <LinkSelfStep me={me} onDone={onDone} />}
      </Glass>
    </div>
  );
}

function WaitForAdmin({ text }: { text: string }) {
  return (
    <div className="center stack-sm" style={{ padding: "12px 0" }}>
      <div style={{ fontSize: 40 }}>⏳</div>
      <div className="muted">{text}</div>
    </div>
  );
}

// --- Step 1: connect YouGile --------------------------------------------- */
function ConnectStep({ me, onDone }: Props) {
  const [mode, setMode] = useState<"key" | "login">("key");
  const [apiKey, setApiKey] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setErr("");
    setBusy(true);
    try {
      const creds =
        mode === "key" ? { api_key: apiKey.trim() } : { login: login.trim(), password };
      await api.connectYougile(me.tenant_id, creds);
      notify("success");
      onDone(); // re-fetch me → advances to project step
    } catch (e) {
      notify("error");
      setErr(e instanceof ApiError ? e.message : "Не удалось подключить");
    } finally {
      setBusy(false);
    }
  }

  const valid =
    mode === "key" ? apiKey.trim().length > 10 : login.trim() && password.length > 0;

  return (
    <div className="stack">
      <div>
        <div className="h2">Подключите YouGile</div>
        <div className="faint">Ключ хранится в зашифрованном виде и не виден в чате.</div>
      </div>

      <Segmented
        value={mode}
        onChange={(v) => setMode(v as "key" | "login")}
        options={[
          { value: "key", label: "API-ключ" },
          { value: "login", label: "Логин и пароль" },
        ]}
      />

      {mode === "key" ? (
        <Field
          label="API-ключ YouGile"
          type="password"
          placeholder="вставьте ключ"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      ) : (
        <div className="stack-sm">
          <Field
            label="Логин (email)"
            type="email"
            placeholder="you@company.ru"
            autoComplete="off"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          <Field
            label="Пароль"
            type="password"
            placeholder="пароль YouGile"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="faint">
            Пароль используется один раз для получения ключа и не сохраняется.
          </div>
        </div>
      )}

      {err && <div style={{ color: "var(--bad)", fontSize: 14 }}>{err}</div>}

      <Button onClick={submit} loading={busy} disabled={!valid}>
        Подключить
      </Button>
    </div>
  );
}

// --- Step 2: pick project ------------------------------------------------- */
function ProjectStep({ me, onDone }: Props) {
  const [projects, setProjects] = useState<YougileProject[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api
      .projects(me.tenant_id)
      .then((r) => setProjects(r.projects))
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Ошибка загрузки"));
  }, [me.tenant_id]);

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    setErr("");
    try {
      await api.setProject(me.tenant_id, picked);
      await api.resolveBoard(me.tenant_id);
      notify("success");
      onDone();
    } catch (e) {
      notify("error");
      setErr(e instanceof ApiError ? e.message : "Не удалось подключить проект");
    } finally {
      setBusy(false);
    }
  }

  if (err && !projects) return <ErrorBox text={err} />;
  if (!projects) return <Spinner />;

  return (
    <div className="stack">
      <div>
        <div className="h2">Выберите проект</div>
        <div className="faint">Из этого проекта YouGile будут браться колонки доски.</div>
      </div>
      <div className="stack-sm">
        {projects.map((p) => (
          <div
            key={p.id}
            className={`row ${picked === p.id ? "selected" : ""}`}
            onClick={() => {
              haptic();
              setPicked(p.id);
            }}
          >
            <div className="avatar">📋</div>
            <div className="grow">
              <div className="title">{p.title || "Без названия"}</div>
            </div>
          </div>
        ))}
      </div>
      {err && <div style={{ color: "var(--bad)", fontSize: 14 }}>{err}</div>}
      <Button onClick={confirm} loading={busy} disabled={!picked}>
        Подключить проект
      </Button>
    </div>
  );
}

// --- Step 3: link yourself ----------------------------------------------- */
function LinkSelfStep({ me, onDone }: Props) {
  const [users, setUsers] = useState<YougileUser[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api
      .yougileUsers(me.tenant_id)
      .then((r) => setUsers(r.users))
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Ошибка загрузки"));
  }, [me.tenant_id]);

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    setErr("");
    try {
      const chosen = users?.find((u) => u.id === picked);
      await api.join(me.tenant_id, picked, chosen?.name);
      notify("success");
      onDone();
    } catch (e) {
      notify("error");
      setErr(e instanceof ApiError ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (err && !users) return <ErrorBox text={err} />;
  if (!users) return <Spinner />;

  const filtered = users.filter((u) =>
    (u.name || u.email).toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="stack">
      <div>
        <div className="h2">Кто вы в YouGile?</div>
        <div className="faint">Свяжем ваш Telegram с сотрудником — задачи будут назначаться вам.</div>
      </div>
      {users.length > 6 && (
        <Field
          placeholder="🔍 Поиск по имени"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="stack-sm" style={{ maxHeight: "44vh", overflowY: "auto" }}>
        {filtered.map((u) => (
          <div
            key={u.id}
            className={`row ${picked === u.id ? "selected" : ""}`}
            onClick={() => {
              haptic();
              setPicked(u.id);
            }}
          >
            <Avatar name={u.name || u.email} />
            <div className="grow">
              <div className="title">{u.name || u.email}</div>
              {u.name && u.email && <div className="faint">{u.email}</div>}
            </div>
            {picked === u.id && <span style={{ color: "var(--brand-400)" }}>✓</span>}
          </div>
        ))}
      </div>
      {err && <div style={{ color: "var(--bad)", fontSize: 14 }}>{err}</div>}
      <Button onClick={confirm} loading={busy} disabled={!picked}>
        Это я
      </Button>
    </div>
  );
}

// --- shared bits ---------------------------------------------------------- */
function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ display: "flex", gap: 4, padding: 4, background: "rgba(0,0,0,0.22)", borderRadius: 14 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => {
            haptic();
            onChange(o.value);
          }}
          style={{
            flex: 1,
            border: 0,
            cursor: "pointer",
            padding: "10px 8px",
            borderRadius: 11,
            fontSize: 14,
            fontWeight: 600,
            color: value === o.value ? "#fff" : "var(--ink-faint)",
            background:
              value === o.value
                ? "linear-gradient(150deg, var(--brand-400), var(--brand))"
                : "transparent",
            transition: "all .2s ease",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="center stack-sm" style={{ padding: "12px 0" }}>
      <div style={{ fontSize: 36 }}>⚠️</div>
      <div className="muted">{text}</div>
    </div>
  );
}
