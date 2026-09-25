import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, Plus, RefreshCw, X } from "lucide-react";
import type { Api } from "./api";

type Member = {
  id: string;
  name: string;
  enabled: boolean;
  is_admin: boolean;
  quota_limit: number;
  quota_used: number;
  quota_reserved: number;
};
export default function AccessManagement({
  api,
  onError,
}: {
  api: Api;
  onError: (e: unknown) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]),
    [name, setName] = useState(""),
    [limit, setLimit] = useState(100),
    [issued, setIssued] = useState<{ name: string; token: string } | null>(
      null,
    ),
    [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const refresh = async () => {
    try {
      const r = await api.request<{ users: Member[] }>("/admin/users");
      if (mounted.current) setMembers(r.users);
    } catch (e) {
      if (mounted.current) onError(e);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [api]);
  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.request<{ user: Member; access_token: string }>(
        "/admin/users",
        { name: name.trim(), quota_limit: limit },
      );
      if (!mounted.current) return;
      setIssued({ name: r.user.name, token: r.access_token });
      setName("");
      await refresh();
    } catch (e) {
      if (mounted.current) onError(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function update(member: Member, patch: Partial<Member>) {
    try {
      await api.request(`/admin/users/${member.id}`, patch, "PATCH");
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) onError(e);
    }
  }
  async function rotate(member: Member) {
    if (
      !confirm(
        `为“${member.name}”更换访问口令？旧口令会立即失效，图库归属与额度保持。`,
      )
    )
      return;
    try {
      const r = await api.request<{ access_token: string }>(
        `/admin/users/${member.id}/rotate`,
        {},
      );
      if (mounted.current)
        setIssued({ name: member.name, token: r.access_token });
    } catch (e) {
      if (mounted.current) onError(e);
    }
  }
  return (
    <section className="access-management">
      <div className="settings-heading">
        <KeyRound size={19} />
        <h2>朋友访问</h2>
        <button
          className="icon-button"
          aria-label="刷新访问列表"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <p>单独的访问口令与使用上限。彼此的提示词、任务和作品各自保存。</p>
      <form
        className="access-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span>称呼</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="朋友的称呼"
            maxLength={60}
          />
        </label>
        <label className="field">
          <span>使用上限</span>
          <input
            type="number"
            min="0"
            max="1000000"
            step="1"
            value={limit}
            onChange={(e) => setLimit(+e.target.value)}
            required
          />
        </label>
        <button disabled={busy || !name.trim()}>
          <Plus size={14} />
          创建口令
        </button>
      </form>
      {issued && (
        <div className="issued-token">
          <div>
            <b>{issued.name}的新口令</b>
            <button
              className="icon-button"
              aria-label="关闭新口令"
              onClick={() => setIssued(null)}
            >
              <X size={14} />
            </button>
          </div>
          <input
            readOnly
            aria-label="新访问口令"
            value={issued.token}
            onFocus={(e) => e.currentTarget.select()}
          />
          <small>仅在这里显示一次。请先复制保存，再关闭。</small>
          <button onClick={() => setIssued(null)}>
            <Check size={13} />
            已保存
          </button>
        </div>
      )}
      <div className="member-list">
        {members.map((member) => (
          <article key={member.id}>
            <div>
              <b>{member.name}</b>
              <small>
                {member.is_admin ? "维护者 · " : ""}
                {member.enabled ? "可用" : "已停用"} · 已用 {member.quota_used}{" "}
                / {member.quota_limit}
              </small>
            </div>
            <div>
              <button onClick={() => void rotate(member)}>
                <RefreshCw size={12} />
                换口令
              </button>
              {!member.is_admin && (
                <button
                  onClick={() =>
                    void update(member, { enabled: !member.enabled })
                  }
                >
                  {member.enabled ? "停用" : "启用"}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
