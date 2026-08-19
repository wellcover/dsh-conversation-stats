/**
 * dsh-conversation-stats — CLIENT half (browser).
 *
 * A "conversation.view" tab (same top bar as 对话 / 轨迹) that lists every
 * conversation's stats — turns, steps, model calls, token usage (input /
 * output / cache), wall times, models and tools — and lets the user open one
 * conversation to inspect per-call detail. Data comes from the host routes
 * /conversation-stats/api (list) and /conversation-stats/api/detail?id=…
 * (single session), which parse the durable session logs.
 *
 * Hand-written React (require("react") + React.createElement, no JSX, no build
 * step), following the @feiyang666/dsh-usage-plugin client conventions.
 */
window.__ModuleLoader__.load({
  id: "dsh-conversation-stats",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var el = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    // ── config ─────────────────────────────────────────────────────────────
    var API_LIST = "/conversation-stats/api";
    var API_DETAIL = "/conversation-stats/api/detail";
    var API_DELETE = "/conversation-stats/api/delete";
    var REFRESH_MS = 60 * 1000;

    // ── base styles (em-scaled like the shell's display-size setting) ──────
    var BASE_FS = 13;
    function fs(n) { return (Math.round(n / BASE_FS * 100) / 100).toFixed(2) + "em"; }
    var st = {
      root: { width: "100%", maxWidth: "100%", minWidth: 0, boxSizing: "border-box" },
      head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 },
      headL: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      title: { fontSize: fs(15), fontWeight: 600 },
      sub: { fontSize: fs(11), opacity: 0.55 },
      chips: { display: "flex", gap: 8, flexWrap: "wrap" },
      chip: { border: "1px solid rgba(128,128,128,.35)", borderRadius: 8, padding: "4px 10px", fontSize: fs(11) },
      chipV: { fontWeight: 600 },
      btn: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "4px 10px", fontSize: fs(12), cursor: "pointer", color: "inherit" },
      btnPrimary: { border: "1px solid rgba(90,140,255,.6)", background: "rgba(90,140,255,.22)", borderRadius: 6, padding: "4px 10px", fontSize: fs(12), cursor: "pointer", color: "inherit" },
      wrap: { maxWidth: "min(1400px, calc(100vw - 24px))", margin: "0 auto", width: "100%", minWidth: 0, boxSizing: "border-box" },
      err: { padding: "14px 16px", borderRadius: 10, border: "1px solid rgba(239,68,68,.4)", background: "rgba(239,68,68,.08)", fontSize: fs(12), color: "inherit" },
      note: { fontSize: fs(11), opacity: 0.55, marginTop: 8 },
      scroll: { overflowX: "auto", width: "100%", maxWidth: "100%", minWidth: 0 },
      tbl: { width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: fs(12) },
      th: { textAlign: "left", padding: "7px 10px", borderBottom: "1px solid rgba(128,128,128,.25)", whiteSpace: "nowrap", fontWeight: 600, position: "sticky", top: 0, background: "inherit" },
      td: { padding: "6px 10px", borderBottom: "1px solid rgba(128,128,128,.12)", whiteSpace: "nowrap", verticalAlign: "top" },
      row: { cursor: "pointer" },
      rowSel: { background: "rgba(90,140,255,.14)" },
      small: { fontSize: fs(10), opacity: 0.6 },
      sec: { fontSize: fs(13), fontWeight: 600, margin: "14px 0 6px" },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 8 },
      card: { border: "1px solid rgba(128,128,128,.3)", borderRadius: 8, padding: "8px 10px", fontSize: fs(11), minWidth: 0 },
      cardL: { opacity: 0.6, marginBottom: 2 },
      cardV: { fontWeight: 600, overflowWrap: "anywhere" },
      delBtn: { border: "1px solid rgba(239,68,68,.5)", background: "rgba(239,68,68,.10)", borderRadius: 5, padding: "2px 8px", fontSize: fs(11), cursor: "pointer", color: "inherit" },
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
      modal: { width: "min(360px, calc(100vw - 40px))", border: "1px solid rgba(239,68,68,.45)", borderRadius: 12, background: "inherit", padding: "16px 18px", fontSize: fs(12) },
      modalTitle: { fontSize: fs(14), fontWeight: 700, color: "rgba(239,68,68,1)", marginBottom: 8 },
      modalText: { lineHeight: 1.6, opacity: 0.9, marginBottom: 14, overflowWrap: "anywhere" },
      modalActions: { display: "flex", gap: 8, justifyContent: "flex-end" },
      modalBtn: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "5px 14px", fontSize: fs(12), cursor: "pointer", color: "inherit" },
      modalBtnDanger: { border: "1px solid rgba(239,68,68,.6)", background: "rgba(239,68,68,.85)", borderRadius: 6, padding: "5px 14px", fontSize: fs(12), cursor: "pointer", color: "#fff", fontWeight: 600 },
      modalErr: { color: "rgba(239,68,68,1)", fontSize: fs(11), marginTop: 10 },
      modalNote: { fontSize: fs(10), opacity: 0.6, marginTop: 8, lineHeight: 1.5 },
    };

    // ── formatters ─────────────────────────────────────────────────────────
    function fmtInt(n) {
      n = n || 0;
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    function fmtCompact(n) {
      n = n || 0;
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(Math.round(n));
    }
    function fmtMs(ms) {
      ms = Math.round(ms || 0);
      if (ms < 1000) return ms + " ms";
      if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
      var m = Math.floor(ms / 60000);
      var s = Math.round((ms % 60000) / 1000);
      return m + "m " + String(s).padStart(2, "0") + "s";
    }
    function fmtTime(ts) {
      if (!ts) return "—";
      var d = new Date(ts);
      if (isNaN(d.getTime())) return "—";
      var p = (n) => String(n).padStart(2, "0");
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function fmtFullTime(ts) {
      if (!ts) return "—";
      var d = new Date(ts);
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleString();
    }

    // ── fetch helper ───────────────────────────────────────────────────────
    async function getJson(url) {
      var res = await fetch(url, { cache: "no-store" });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || "HTTP " + res.status + " 请求失败");
      }
      return data;
    }

    // 删除走 GET（query 传 id）：DSH webServer 对非 GET/HEAD 方法统一返回 405，
    // 而本插件 list/detail 均为 GET 且已验证可用，故与之一致。
    async function deleteSession(id) {
      var res = await fetch(API_DELETE + "?id=" + encodeURIComponent(id), { cache: "no-store" });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || "HTTP " + res.status + " 删除失败");
      }
      return data;
    }

    // ── components ─────────────────────────────────────────────────────────
    function Chip(props) {
      return el("span", { style: st.chip },
        el("span", { style: st.chipV }, String(props.value)),
        el("span", {}, " " + props.label)
      );
    }

    function EmptyRow(props) {
      return el("tr", {},
        el("td", { colSpan: props.cols || 1, style: { padding: "18px 12px", textAlign: "center", opacity: 0.55, fontSize: fs(12) } }, props.text || "暂无数据")
      );
    }

    // ── summary table ──────────────────────────────────────────────────────
    function SummaryTable(props) {
      var sessions = props.sessions || [];
      var keys = ["title", "turns", "steps", "calls", "outputTokens", "inputTokens", "cacheReadTokens", "lastTime"];
      var heads = ["会话", "轮数", "步数", "调用", "输出tok", "输入tok", "缓存tok", "最后活跃", "删除"];
      var rows = sessions.map(function (s) {
        var title = s.title || (s.firstUserText ? s.firstUserText.slice(0, 40) + "…" : "(无标题)");
        var total = (s.outputTokens || 0) + (s.inputTokens || 0) + (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0);
        return el("tr", {
          key: s.id,
          style: props.selectedId === s.id ? Object.assign({}, st.row, st.rowSel) : st.row,
          onClick: function () { props.onPick && props.onPick(s); },
          title: "点击查看详情：" + s.id,
        },
          el("td", { style: st.td },
            el("div", { style: { fontWeight: 600 } }, title),
            el("div", { style: st.small }, (s.cwd || s.workspaceKey || "") + " · " + fmtCompact(total) + " tok")
          ),
          el("td", { style: st.td }, fmtInt(s.turns)),
          el("td", { style: st.td }, fmtInt(s.steps)),
          el("td", { style: st.td }, fmtInt(s.calls)),
          el("td", { style: st.td }, fmtCompact(s.outputTokens)),
          el("td", { style: st.td }, fmtCompact(s.inputTokens)),
          el("td", { style: st.td }, fmtCompact(s.cacheReadTokens)),
          el("td", { style: st.td }, fmtTime(s.lastTime)),
          el("td", { style: st.td }, el("button", {
            style: st.delBtn,
            title: "彻底删除该会话（不可恢复）",
            onClick: function (e) { e.stopPropagation(); props.onDelete && props.onDelete(s); }
          }, "删除"))
        );
      });
      return el("div", { style: st.scroll },
        el("table", { style: st.tbl },
          el("thead", {}, el("tr", {}, heads.map(function (h, i) { return el("th", { key: i, style: st.th }, h); }))),
          el("tbody", {}, rows.length > 0 ? rows : el(EmptyRow, { cols: heads.length, text: "没有找到会话记录" }))
        )
      );
    }

    // ── detail view ────────────────────────────────────────────────────────
    function DetailView(props) {
      var s = props.session;
      var total = (s.outputTokens || 0) + (s.inputTokens || 0) + (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0);
      var models = Object.entries(s.models || {}).map(function (kv) { return kv[0] + " × " + kv[1]; }).join("、") || "—";
      var stopR = Object.entries(s.stopReasons || {}).map(function (kv) { return kv[0] + " × " + kv[1]; }).join("、") || "—";
      var tools = (s.toolsDetail || []);

      var calls = (s.callsDetail || []).map(function (c) {
        return el("tr", { key: c.seq },
          el("td", { style: st.td }, fmtTime(c.time)),
          el("td", { style: st.td }, c.model || c.provider || "—"),
          el("td", { style: st.td }, c.stopReason || "—"),
          el("td", { style: st.td }, fmtCompact(c.inputTokens)),
          el("td", { style: st.td }, fmtCompact(c.outputTokens)),
          el("td", { style: st.td }, fmtCompact(c.cacheRead)),
          el("td", { style: st.td }, (c.tools && c.tools.length ? c.tools.join("、") : "—"))
        );
      });

      var toolRows = tools.map(function (t) {
        return el("tr", { key: t.name },
          el("td", { style: st.td }, t.name),
          el("td", { style: st.td }, fmtInt(t.count)),
          el("td", { style: st.td }, fmtMs(t.ms)),
          el("td", { style: st.td }, t.errors > 0 ? String(t.errors) + " ✗" : "0")
        );
      });

      return el("div", {},
        el("button", { style: st.btn, onClick: props.onBack }, "← 返回列表"),
        el("div", { style: st.sec }, "会话信息"),
        el("div", { style: st.grid },
          el("div", { style: st.card }, el("div", { style: st.cardL }, "会话 ID"), el("div", { style: st.cardV }, s.id || "—")),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "工作区 / 标题"), el("div", { style: st.cardV }, (s.cwd || s.workspaceKey || "—") + (s.title ? " · " + s.title : ""))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "创建 / 最后活跃"), el("div", { style: st.cardV }, fmtFullTime(s.createdAt) + " / " + fmtFullTime(s.lastTime))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "轮数 / 步数 / 调用"), el("div", { style: st.cardV }, fmtInt(s.turns) + " / " + fmtInt(s.steps) + " / " + fmtInt(s.calls))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "Token 总计"), el("div", { style: st.cardV }, fmtInt(total))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "输入 / 输出 / 缓存读 / 缓存写"), el("div", { style: st.cardV }, fmtCompact(s.inputTokens) + " / " + fmtCompact(s.outputTokens) + " / " + fmtCompact(s.cacheReadTokens) + " / " + fmtCompact(s.cacheWriteTokens))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "LLM 耗时 / 工具耗时"), el("div", { style: st.cardV }, fmtMs(s.llmMs) + " / " + fmtMs(s.toolMs))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "首页延迟(均值) / 解码 token"), el("div", { style: st.cardV }, (s.ttftSteps > 0 ? fmtMs(s.ttftMs / s.ttftSteps) : "—") + " / " + fmtCompact(s.decodeTokens))),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "模型"), el("div", { style: st.cardV, overflowWrap: "anywhere" }, models)),
          el("div", { style: st.card }, el("div", { style: st.cardL }, "结束原因"), el("div", { style: st.cardV }, stopR))
        ),
        el("div", { style: st.sec }, "工具调用（" + fmtInt(tools.reduce(function (a, t) { return a + t.count; }, 0)) + "）"),
        el("div", { style: st.scroll },
          el("table", { style: st.tbl },
            el("thead", {}, el("tr", {},
              el("th", { style: st.th }, "工具"), el("th", { style: st.th }, "次数"), el("th", { style: st.th }, "总耗时"), el("th", { style: st.th }, "失败")
            )),
            el("tbody", {}, toolRows.length > 0 ? toolRows : el(EmptyRow, { cols: 4, text: "无工具调用" }))
          )
        ),
        el("div", { style: st.sec }, "模型调用明细（" + fmtInt(calls.length) + "）"),
        el("div", { style: st.scroll },
          el("table", { style: st.tbl },
            el("thead", {}, el("tr", {},
              el("th", { style: st.th }, "时间"), el("th", { style: st.th }, "模型"), el("th", { style: st.th }, "结束原因"),
              el("th", { style: st.th }, "输入"), el("th", { style: st.th }, "输出"), el("th", { style: st.th }, "缓存"), el("th", { style: st.th }, "工具")
            )),
            el("tbody", {}, calls.length > 0 ? calls : el(EmptyRow, { cols: 7, text: "无模型调用" }))
          )
        )
      );
    }

    // ── main panel ─────────────────────────────────────────────────────────
    function StatsPanel() {
      var listState = useState({ sessions: [], loaded: false });
      var meta = useState({ scannedAt: null, totals: null, error: null, loading: false, refreshing: false, detail: null, detailLoading: false, detailError: null, deleteTarget: null, deleting: false, deleteError: null });
      var data = listState[0];
      var setData = listState[1];
      var m = meta[0];
      var setM = meta[1];

      var loadList = useCallback(function (force) {
        setM(function (prev) { return Object.assign({}, prev, { loading: prev.loaded ? false : true, refreshing: prev.loaded ? true : false }); });
        getJson(API_LIST + (force ? "?refresh=1" : ""))
          .then(function (res) {
            var sessions = res.sessions || [];
            var totals = sessions.reduce(function (acc, s) {
              acc.sessions += 1;
              acc.turns += s.turns || 0;
              acc.steps += s.steps || 0;
              acc.calls += s.calls || 0;
              acc.tokens += (s.outputTokens || 0) + (s.inputTokens || 0) + (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0);
              return acc;
            }, { sessions: 0, turns: 0, steps: 0, calls: 0, tokens: 0 });
            setData({ sessions: sessions, loaded: true });
            setM(function (prev) { return Object.assign({}, prev, { scannedAt: res.scannedAt, totals: totals, error: null, loading: false, refreshing: false }); });
          })
          .catch(function (e) {
            setM(function (prev) { return Object.assign({}, prev, { error: String((e && e.message) || e), loading: false, refreshing: false }); });
          });
      }, []);

      var openDetail = useCallback(function (s) {
        setM(function (prev) { return Object.assign({}, prev, { detailLoading: true, detailError: null, detail: null }); });
        getJson(API_DETAIL + "?id=" + encodeURIComponent(s.id))
          .then(function (res) {
            setM(function (prev) { return Object.assign({}, prev, { detail: res.session || null, detailLoading: false }); });
          })
          .catch(function (e) {
            setM(function (prev) { return Object.assign({}, prev, { detailLoading: false, detailError: String((e && e.message) || e) }); });
          });
      }, []);

      var closeDetail = useCallback(function () {
        setM(function (prev) { return Object.assign({}, prev, { detail: null, detailError: null }); });
      }, []);

      // ── 彻底删除会话：确认弹层 → POST → 刷新 ──
      function openDelete(s) {
        if (!s || !s.id) return;
        setM(function (prev) { return Object.assign({}, prev, { deleteTarget: s, deleteError: null }); });
      }
      function closeDelete() {
        setM(function (prev) { return Object.assign({}, prev, { deleteTarget: null, deleteError: null }); });
      }
      async function confirmDelete() {
        var target = m.deleteTarget;
        if (!target) return;
        setM(function (prev) { return Object.assign({}, prev, { deleting: true, deleteError: null }); });
        try {
          await deleteSession(target.id);
          setM(function (prev) {
            var next = Object.assign({}, prev, { deleteTarget: null, deleting: false, deleteError: null });
            if (prev.detail && prev.detail.id === target.id) next.detail = null;
            return next;
          });
          loadList(true); // 强制重扫，刷新列表与汇总
        } catch (e) {
          setM(function (prev) { return Object.assign({}, prev, { deleting: false, deleteError: String((e && e.message) || e) }); });
        }
      }

      useEffect(function () {
        loadList(false);
        var timer = setInterval(function () { loadList(false); }, REFRESH_MS);
        return function () { clearInterval(timer); };
      }, [loadList]);

      var head = el("div", { style: st.head },
        el("div", { style: st.headL },
          el("span", { style: st.title }, "会话统计"),
          el("span", { style: st.sub }, m.scannedAt ? "扫描于 " + fmtFullTime(m.scannedAt) : ""),
          m.refreshing ? el("span", { style: st.sub }, "刷新中…") : null
        ),
        el("div", { style: st.headL },
          m.detail ? null : el("button", {
            style: st.btnPrimary,
            onClick: function () { loadList(true); },
            disabled: m.refreshing,
            title: "重新扫描会话日志",
          }, m.refreshing ? "刷新中…" : "刷新"),
          m.detail ? el("button", { style: st.btn, onClick: closeDetail }, "返回列表") : null
        )
      );

      var body;
      if (m.error !== null && !data.loaded) {
        body = el("div", { style: st.err }, "会话统计加载失败：" + m.error);
      } else if (m.detail !== null) {
        body = el(DetailView, { session: m.detail, onBack: closeDetail });
      } else if (m.detailLoading) {
        body = el("div", { style: { padding: 16, opacity: 0.6, fontSize: fs(12) } }, "加载会话详情…");
      } else if (!data.loaded) {
        body = el("div", { style: { padding: 16, opacity: 0.6, fontSize: fs(12) } }, "正在扫描会话日志…");
      } else {
        var totals = m.totals || { sessions: 0, turns: 0, steps: 0, calls: 0, tokens: 0 };
        body = el("div", {},
          el("div", { style: st.chips, marginBottom: 10 },
            el(Chip, { value: fmtInt(totals.sessions), label: "会话" }),
            el(Chip, { value: fmtInt(totals.turns), label: "轮数" }),
            el(Chip, { value: fmtInt(totals.steps), label: "步数" }),
            el(Chip, { value: fmtInt(totals.calls), label: "模型调用" }),
            el(Chip, { value: fmtCompact(totals.tokens), label: "token" })
          ),
          m.error !== null ? el("div", { style: st.err, marginBottom: 10 }, m.error) : null,
          el(SummaryTable, { sessions: data.sessions, onPick: openDetail, selectedId: null, onDelete: openDelete }),
          el("div", { style: st.note }, "数据来自会话日志解析（" + fmtInt(data.sessions.length) + " 个会话），每 60 秒自动刷新。点击任意会话查看逐条调用明细。")
        );
      }

      // ── 彻底删除确认弹层 ──
      var modal = m.deleteTarget ? el("div", {
        style: st.overlay,
        onClick: m.deleting ? null : closeDelete
      }, el("div", { style: st.modal, onClick: function (e) { e.stopPropagation(); } },
        el("div", { style: st.modalTitle }, "彻底删除会话"),
        el("div", { style: st.modalText }, "确定要彻底删除会话「" + (m.deleteTarget.title || m.deleteTarget.firstUserText || m.deleteTarget.id) + "」吗？将删除其磁盘上的会话日志（session.jsonl.zstd），此操作不可恢复。"),
        m.deleteError ? el("div", { style: st.modalErr }, "删除失败：" + m.deleteError) : null,
        el("div", { style: st.modalActions },
          el("button", { style: st.modalBtn, disabled: m.deleting, onClick: closeDelete }, "取消"),
          el("button", { style: st.modalBtnDanger, disabled: m.deleting, onClick: confirmDelete }, m.deleting ? "删除中…" : "确认删除")
        ),
        el("div", { style: st.modalNote }, "若该会话当前正在使用，删除后可能无法继续写入日志。")
      )) : null;

      return el("div", { style: st.wrap }, el("div", { style: st.root }, head, body, modal));
    }

    // ── plugin contract ────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      try {
        slots.inject("conversation.view", function () {
          return slots.register(
            { name: "conversation.view", id: "conversation-stats-view", order: 40, label: "会话统计" },
            function () { return el(StatsPanel, null); }
          );
        });
      } catch (e) {
        console.warn("[dsh-conversation-stats] register failed:", e);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});