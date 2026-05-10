import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Eye, EyeOff, Loader2, Save, Settings, Sparkles, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_SYSTEM_PROMPT = `你是一个实用的 Prompt 整理助手。
你的任务是：把用户随手输入的一句话，整理成更清楚、更具体、更容易让 AI 理解的提示词。

要求：
1. 保留用户原本的意思，不要过度发挥。
2. 用日常、自然、好理解的表达，不要写得太学术、太架构化。
3. 如果用户说得太简单，可以适当补充背景、目标、输出格式和注意事项。
4. 输出长度要适中，不要写成长篇文档。
5. 只输出整理后的 Prompt，不要说“下面是优化后的提示词”等开场白。
6. 如果用户是在问编程问题，再补充必要的技术细节；如果是日常写作、总结、翻译、规划等任务，就按对应场景整理。

输出格式建议：
- 先用一句话说明任务目标。
- 再列出 2-5 条具体要求。
- 如有必要，最后补充期望的输出格式。`;

const PLACEHOLDER_API_URL = "https://api.deepseek.com/chat/completions";
const PLACEHOLDER_MODEL = "deepseek-v4-flash";

const DEFAULT_SETTINGS = {
  apiKey: "",
  apiUrl: "",
  model: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

const STORAGE_KEY = "prism-settings-v1";
type PrismSettings = typeof DEFAULT_SETTINGS;
type ViewMode = "compose" | "settings";
type Status = "idle" | "loading" | "success" | "error";

function loadSettings(): PrismSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function App() {
  const [view, setView] = useState<ViewMode>("compose");
  const [settings, setSettings] = useState(loadSettings);
  const [draft, setDraft] = useState(loadSettings);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("准备就绪");
  const [lastCount, setLastCount] = useState(0);
  const [showKey, setShowKey] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const loading = status === "loading";
  const configured = useMemo(() => Boolean(settings.apiKey), [settings]);

  useEffect(() => {
    const win = getCurrentWindow();
    const size = view === "compose" ? new LogicalSize(680, 100) : new LogicalSize(720, 580);
    void win.setSize(size).then(() => win.center());
    const id = window.setTimeout(() => inputRef.current?.focus(), 100);
    return () => window.clearTimeout(id);
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view === "settings") setView("compose");
        else void invoke("hide_window");
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings, view]);

  const openSettings = () => {
    setDraft(settings);
    setView("settings");
  };

  const startDrag = () => {
    void getCurrentWindow().startDragging();
  };

  const updateDraft = <K extends keyof PrismSettings>(key: K, value: PrismSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = () => {
    const next = {
      ...draft,
      apiKey: draft.apiKey.trim(),
      apiUrl: draft.apiUrl.trim(),
      model: draft.model.trim(),
      systemPrompt: draft.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
    };
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setStatus("success");
    setMessage("配置已保存");
    setView("compose");
  };

  const callModel = async (content: string) => {
    const url = settings.apiUrl || PLACEHOLDER_API_URL;
    const model = settings.model || PLACEHOLDER_MODEL;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content },
        ],
        temperature: 0.2,
        stream: true,
      }),
    });

    if (!res.ok) throw new Error((await res.text()) || `模型请求失败：${res.status}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) result += delta;
        } catch {
          // skip malformed chunks
        }
      }
    }

    if (!result.trim()) throw new Error("模型返回为空，请检查 API Key、模型名称或账户余额");
    return result.trim();
  };

  const submit = async () => {
    const content = input.trim();
    if (!content || loading) return;

    if (!configured) {
      setStatus("error");
      setMessage("请先配置 API Key");
      openSettings();
      return;
    }

    setStatus("loading");
    setMessage("大模型正在推理");
    try {
      const prompt = await callModel(content);
      setLastCount(prompt.length);
      setInput("");
      setStatus("success");
      setMessage("已生成并注入");
      await invoke("inject_prompt", { text: prompt });
      window.setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      const text = err instanceof Error ? err.message : "未知错误";
      setStatus("error");
      setMessage(text.length > 140 ? `${text.slice(0, 140)}...` : text);
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-[#0a0e1a] via-[#0d1220] to-[#0a0e1a] p-4 text-white">
      <motion.main initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }} className="glass-shell relative h-full w-full overflow-hidden rounded-[32px] shadow-[0_8px_32px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.08),inset_0_1px_0_rgba(255,255,255,0.12)]">
        <div className="aurora-layer" />
        <div className="mesh-overlay" />

        <AnimatePresence mode="wait">
          {view === "compose" ? (
            <motion.section key="compose" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.18 }} className="relative flex h-full items-center px-5">
              <button type="button" onMouseDown={startDrag} className="absolute left-1/2 top-3 h-1 w-14 -translate-x-1/2 rounded-full bg-white/20" aria-label="拖动窗口" />
              <div className="flex w-full items-center gap-3 rounded-[22px] border border-white/15 bg-white/[0.08] px-4 py-3.5 backdrop-blur-xl">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400 to-indigo-500">
                  {loading ? <Loader2 className="h-5 w-5 animate-spin text-white" /> : <Sparkles className="h-5 w-5 text-white" />}
                </div>
                <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} disabled={loading} placeholder={loading ? "正在生成..." : "输入你的想法，回车生成专业 Prompt"} className="min-w-0 flex-1 bg-transparent text-lg font-medium text-white outline-none placeholder:text-white/35 disabled:opacity-50" />
                {status === "success" && <Check className="h-5 w-5 text-emerald-400" />}
                {status === "error" && <Zap className="h-5 w-5 text-rose-400" />}
                <button onClick={openSettings} className="rounded-xl border border-white/15 bg-white/10 p-2.5 text-white/70 transition hover:bg-white/15 hover:text-white"><Settings className="h-4 w-4" /></button>
              </div>
            </motion.section>
          ) : (
            <motion.section key="settings" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.2 }} className="relative flex h-full flex-col p-5">
              <header onMouseDown={startDrag} className="mb-4 flex shrink-0 cursor-move items-center justify-between rounded-2xl border border-white/15 bg-white/[0.08] px-4 py-3">
                <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setView("compose")} className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15"><ArrowLeft className="h-4 w-4" />返回</button>
                <div className="flex items-center gap-3">
                  <div className="text-right"><h2 className="text-lg font-bold">Prism 设置</h2><p className="text-xs text-white/50">DeepSeek-V3 极速生成 · 自动注入</p></div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400 to-indigo-500"><Sparkles className="h-5 w-5 text-white" /></div>
                </div>
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto pr-1">
                <Card title="API Key" sub="必须配置才能调用大模型">
                  <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-black/30 px-4 py-3 focus-within:border-cyan-300/40">
                    <input type={showKey ? "text" : "password"} value={draft.apiKey} onChange={(e) => updateDraft("apiKey", e.target.value)} placeholder="sk-..." className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30" />
                    <button onClick={() => setShowKey(!showKey)} className="text-white/50 hover:text-white">{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </Card>
                <div className="grid grid-cols-2 gap-3">
                  <Card title="模型" sub="留空默认 deepseek-v4-flash（最快）"><input value={draft.model} onChange={(e) => updateDraft("model", e.target.value)} className="field-input" placeholder="deepseek-v4-flash" /></Card>
                  <Card title="运行状态" sub="调用链路"><div className="rounded-2xl border border-white/10 bg-black/25 p-3 text-sm text-white/80">{message}<br /><span className="text-xs text-white/50">{configured ? `模型：${settings.model || PLACEHOLDER_MODEL}` : "未配置 API Key"}{lastCount ? ` · ${lastCount} 字` : ""}</span></div></Card>
                </div>
                <Card title="API 地址" sub="留空默认 DeepSeek 官方地址"><input value={draft.apiUrl} onChange={(e) => updateDraft("apiUrl", e.target.value)} className="field-input" placeholder="https://api.deepseek.com/chat/completions" /></Card>
                <Card title="快捷键" sub="系统级操作"><div className="rounded-2xl border border-white/10 bg-black/25 p-3 text-xs leading-7 text-white/80">Alt + Q：唤起/隐藏 &nbsp;·&nbsp; Enter：生成并注入 &nbsp;·&nbsp; Esc：隐藏/返回 &nbsp;·&nbsp; Ctrl + ,：设置</div></Card>
                <Card title="System Prompt" sub="定义大模型的输出风格"><textarea value={draft.systemPrompt} onChange={(e) => updateDraft("systemPrompt", e.target.value)} rows={8} className="w-full resize-none rounded-2xl border border-white/10 bg-black/25 p-4 text-xs leading-relaxed text-white outline-none focus:border-cyan-300/40" /></Card>
              </div>

              <footer className="mt-4 flex shrink-0 items-center justify-between gap-4">
                <button onClick={() => updateDraft("systemPrompt", DEFAULT_SYSTEM_PROMPT)} className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm text-white transition hover:bg-white/12">恢复默认 Prompt</button>
                <button onClick={save} className="flex items-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-400 to-indigo-500 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-cyan-500/25 transition hover:scale-[1.02] hover:shadow-cyan-500/40">
                  <Save className="h-4 w-4" />
                  <span>保存所有设置</span>
                </button>
              </footer>
            </motion.section>
          )}
        </AnimatePresence>
      </motion.main>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; wide?: boolean; grow?: boolean; children: ReactNode }) {
  return <div className="card-panel rounded-2xl border border-white/12 bg-white/[0.08] p-4"><div className="mb-2"><h3 className="text-sm font-bold text-white">{title}</h3><p className="mt-0.5 text-xs text-white/45">{sub}</p></div><div>{children}</div></div>;
}

export default App;
