import React, { useState, useRef, useEffect, useCallback } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import {
  Send, Brain, Menu, X, Bot, User, Trash2, Plus,
  MessageSquare, Edit3, LogOut,
  Clock, Database, Search, Copy, CheckCheck, Zap
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ─── Copy Button ──────────────────────────────────────────────────────────────
function CopyButton({ text, className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const el = document.createElement('textarea');
      el.value = text; document.body.appendChild(el);
      el.select(); document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} title="Copy"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all duration-200
        ${copied
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-white/5 hover:bg-white/10 text-slate-500 hover:text-slate-300'}
        ${className}`}>
      {copied ? <><CheckCheck className="w-3 h-3"/>Copied</> : <><Copy className="w-3 h-3"/>Copy</>}
    </button>
  );
}

// ─── Markdown with code copy ──────────────────────────────────────────────────
function MarkdownWithCopy({ content }) {
  const blocks = [];
  const re = /```([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      const t = content.slice(last, m.index).trim();
      if (t) blocks.push({ type: 'text', content: t });
    }
    const inner = m[1];
    const nl = inner.indexOf('\n');
    blocks.push({ type: 'code', lang: nl > 0 ? inner.slice(0, nl).trim() : '', content: nl > 0 ? inner.slice(nl + 1).trimEnd() : inner });
    last = m.index + m[0].length;
  }
  if (last < content.length) { const t = content.slice(last).trim(); if (t) blocks.push({ type: 'text', content: t }); }
  if (!blocks.length) blocks.push({ type: 'text', content });

  return (
    <div className="space-y-3">
      {blocks.map((b, i) => b.type === 'code' ? (
        <div key={i} className="rounded-xl overflow-hidden border border-white/10 bg-[#0d0d10]">
          <div className="flex items-center justify-between px-4 py-2 bg-white/[0.03] border-b border-white/[0.06]">
            <span className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">{b.lang || 'code'}</span>
            <CopyButton text={b.content} />
          </div>
          <pre className="px-4 py-3 overflow-x-auto text-[13px] text-slate-300 font-mono leading-relaxed"><code>{b.content}</code></pre>
        </div>
      ) : (
        <div key={i} className="space-y-1.5">
          {b.content.split(/\n\n+/).filter(Boolean).map((p, j) => (
            <ReactMarkdown key={j} components={{
              p: ({children}) => <p className="leading-relaxed text-[14px]">{children}</p>,
              li: ({children}) => <li className="ml-5 list-disc leading-relaxed text-[14px]">{children}</li>,
              ol: ({children}) => <ol className="ml-5 list-decimal space-y-1">{children}</ol>,
              ul: ({children}) => <ul className="space-y-1">{children}</ul>,
              strong: ({children}) => <strong className="font-semibold text-white">{children}</strong>,
              code: ({children}) => <code className="bg-indigo-500/15 text-indigo-300 rounded-md px-1.5 py-0.5 text-[12px] font-mono">{children}</code>,
            }}>{p}</ReactMarkdown>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Font loader ──────────────────────────────────────────────────────────────
const LANG_FONT = {
  "Tamil": "Catamaran:wght@400;600;700", "Tamil (Romanised)": "Catamaran:wght@400;600;700",
  "Hindi": "Hind:wght@400;600;700", "Arabic": "Cairo:wght@400;600;700",
  "French": "Lato:wght@400;700", "Spanish": "Nunito:wght@400;600;700",
  "German": "Source+Sans+3:wght@400;600;700",
  "Kannada": "Noto+Sans+Kannada:wght@400;600;700", "Telugu": "Noto+Sans+Telugu:wght@400;600;700",
};
function useDynamicFont(lang) {
  useEffect(() => {
    const gf = LANG_FONT[lang];
    if (!gf) return;
    const family = gf.split(':')[0].replace(/\+/g, ' ');
    const id = `gf-${family.replace(/\s/g,'-')}`;
    if (!document.getElementById(id)) {
      const l = document.createElement('link');
      l.id = id; l.rel = 'stylesheet';
      l.href = `https://fonts.googleapis.com/css2?family=${gf}&display=swap`;
      document.head.appendChild(l);
    }
    document.documentElement.style.setProperty('--chat-font', `'${family}', sans-serif`);
  }, [lang]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDate = ts => {
  if (!ts) return '';
  const d = new Date(ts), days = Math.floor((Date.now() - d) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? `${days}d ago` : d.toLocaleDateString();
};

// ─── Auth ─────────────────────────────────────────────────────────────────────
function AuthScreen({ onEnter }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!name.trim() || !email.trim()) { setErr('Both fields are required'); return; }
    if (!/\S+@\S+\.\S+/.test(email)) { setErr('Enter a valid email'); return; }
    setBusy(true); setErr('');
    try {
      const r = await axios.post(`${API}/users/register`, { user_name: name.trim(), email: email.trim().toLowerCase() });
      onEnter(r.data);
    } catch { setErr('Cannot connect to server.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#080809] relative overflow-hidden">
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-600/10 rounded-full blur-[120px]"/>
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-violet-600/8 rounded-full blur-[100px]"/>
      </div>
      {/* Subtle dot grid */}
      <div className="absolute inset-0 opacity-[0.025]"
        style={{backgroundImage:'radial-gradient(circle, #ffffff 1px, transparent 1px)', backgroundSize:'28px 28px'}}/>

      <div className="relative z-10 w-full max-w-[380px] px-5">
        <div className="text-center mb-10">
          <div className="relative inline-block mb-5">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-2xl shadow-indigo-500/40">
              <Brain className="w-8 h-8 text-white"/>
            </div>
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-400 rounded-full border-2 border-[#080809] flex items-center justify-center">
              <div className="w-1.5 h-1.5 bg-emerald-300 rounded-full animate-ping"/>
            </div>
          </div>
          <h1 className="text-[32px] font-black text-white tracking-tight leading-none">MemoMind</h1>
          <p className="text-slate-500 text-xs mt-2 tracking-[0.2em] uppercase font-medium">Longitudinal Memory AI</p>
        </div>

        <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl p-6 shadow-2xl backdrop-blur-sm">
          <h2 className="text-white font-bold text-base mb-1">Welcome back</h2>
          <p className="text-slate-500 text-xs mb-5">Your email is your memory key.</p>
          <div className="space-y-3">
            <div className="relative">
              <input value={name} onChange={e=>setName(e.target.value)}
                placeholder="Your name"
                className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.14] focus:border-indigo-500/50 text-white placeholder-slate-600 rounded-xl px-4 py-3 text-sm focus:outline-none transition-all duration-200"/>
            </div>
            <div className="relative">
              <input value={email} onChange={e=>setEmail(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&submit()}
                type="email" placeholder="Email address"
                className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.14] focus:border-indigo-500/50 text-white placeholder-slate-600 rounded-xl px-4 py-3 text-sm focus:outline-none transition-all duration-200"/>
            </div>
            {err && <p className="text-red-400 text-xs px-1">{err}</p>}
            <button onClick={submit} disabled={busy}
              className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold rounded-xl py-3 text-sm flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-40 shadow-lg shadow-indigo-500/20 mt-1">
              {busy
                ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>
                : <><Zap className="w-4 h-4"/> Enter MemoMind</>}
            </button>
          </div>
          <p className="text-slate-700 text-[11px] text-center mt-4">Same email → same memories, always</p>
        </div>
      </div>
    </div>
  );
}

// ─── Chat Item ────────────────────────────────────────────────────────────────
function ChatItem({ chat, active, onSelect, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(chat.title);
  const ref = useRef(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const save = async () => {
    if (val.trim() && val !== chat.title) await onRename(chat.chat_id, val.trim());
    setEditing(false);
  };
  return (
    <div onClick={() => !editing && onSelect(chat)}
      className={`group flex items-start gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-150 select-none
        ${active
          ? 'bg-indigo-600/15 border border-indigo-500/25 shadow-sm shadow-indigo-500/10'
          : 'hover:bg-white/[0.04] border border-transparent'}`}>
      <div className={`mt-0.5 shrink-0 transition-colors ${active ? 'text-indigo-400' : 'text-slate-600 group-hover:text-slate-400'}`}>
        <MessageSquare className="w-3.5 h-3.5"/>
      </div>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input ref={ref} value={val}
            onChange={e=>setVal(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter')save();if(e.key==='Escape')setEditing(false);}}
            onBlur={save} onClick={e=>e.stopPropagation()}
            className="w-full bg-white/10 text-white text-xs rounded-lg px-2 py-1 focus:outline-none border border-indigo-400/40"/>
        ) : (
          <p className={`text-[13px] truncate leading-snug ${active ? 'text-white font-medium' : 'text-slate-400 group-hover:text-slate-300'}`}>
            {chat.title}
          </p>
        )}
        <p className="text-[10px] text-slate-600 mt-0.5">{fmtDate(chat.updated_at || chat.created_at)}</p>
      </div>
      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0" onClick={e=>e.stopPropagation()}>
        <button onClick={()=>setEditing(true)}
          className="p-1.5 hover:bg-white/10 rounded-lg text-slate-600 hover:text-slate-300 transition-all">
          <Edit3 className="w-3 h-3"/>
        </button>
        <button onClick={()=>onDelete(chat.chat_id)}
          className="p-1.5 hover:bg-red-500/15 rounded-lg text-slate-600 hover:text-red-400 transition-all">
          <Trash2 className="w-3 h-3"/>
        </button>
      </div>
    </div>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <div className="flex gap-1 items-center py-1">
      {[0,1,2].map(i => (
        <div key={i} className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce"
          style={{animationDelay:`${i*120}ms`, animationDuration:'0.9s'}}/>
      ))}
    </div>
  );
}

// ─── Main Chat App ────────────────────────────────────────────────────────────
function ChatApp({ user, onLogout }) {
  const { user_id, user_name } = user;
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [semMems, setSemMems] = useState([]);
  const [webSearched, setWebSearched] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [detectedLang, setDetectedLang] = useState('');
  const [activeTab, setTab] = useState('chats');

  useDynamicFont(detectedLang || 'English');

  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const loadChats = useCallback(async () => {
    try { const r = await axios.get(`${API}/chats/${user_id}`); setChats(r.data.chats); } catch {}
  }, [user_id]);

  const loadMessages = useCallback(async (chat_id) => {
    try { const r = await axios.get(`${API}/messages/${chat_id}`); setMessages(r.data.messages); } catch {}
  }, []);

  useEffect(() => { loadChats(); }, [loadChats]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, typing]);
  useEffect(() => { inputRef.current?.focus(); }, [activeChat]);

  const selectChat = async (chat) => {
    setActiveChat(chat); setMessages([]);
    setSemMems([]); setWebSearched(false); setSearchQuery(''); setDetectedLang('');
    await loadMessages(chat.chat_id);
  };

  const newChat = async () => {
    try {
      const r = await axios.post(`${API}/chats`, { user_id, user_name, title: 'New Chat' });
      const chat = { chat_id: r.data.chat_id, title: r.data.title, created_at: r.data.created_at, updated_at: r.data.created_at, message_count: 0 };
      setChats(p => [chat, ...p]);
      setActiveChat(chat); setMessages([]);
      setSemMems([]); setWebSearched(false); setSearchQuery(''); setDetectedLang('');
    } catch {}
  };

  const deleteChat = async (chat_id) => {
    if (!window.confirm('Delete this chat?')) return;
    await axios.delete(`${API}/chats/${chat_id}`);
    setChats(p => p.filter(c => c.chat_id !== chat_id));
    if (activeChat?.chat_id === chat_id) { setActiveChat(null); setMessages([]); }
  };

  const renameChat = async (chat_id, title) => {
    await axios.patch(`${API}/chats/${chat_id}`, { title });
    setChats(p => p.map(c => c.chat_id === chat_id ? {...c, title} : c));
    if (activeChat?.chat_id === chat_id) setActiveChat(prev => ({...prev, title}));
  };

  const sendMessage = async () => {
    if (!input.trim() || busy || !activeChat) return;
    const text = input.trim();
    setInput(''); setBusy(true); setTyping(true);
    setMessages(p => [...p, { role:'user', content:text, timestamp: new Date().toISOString() }]);
    try {
      const r = await axios.post(`${API}/chat`, { content: text, user_id, user_name, chat_id: activeChat.chat_id });
      setSemMems(r.data.cross_chat_memories || []);
      setWebSearched(r.data.web_searched || false);
      setSearchQuery(r.data.search_query || '');
      setDetectedLang(r.data.detected_language || '');
      await loadMessages(activeChat.chat_id);
      await loadChats();
    } catch {
      setMessages(p => [...p, { role:'assistant', content:'⚠️ Connection error — is the backend running?', timestamp: new Date().toISOString(), isError:true }]);
    } finally { setBusy(false); setTyping(false); }
  };

  const initials = user_name.charAt(0).toUpperCase();

  return (
    <div className="flex h-screen bg-[#080809] text-white overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className={`${sidebar ? 'w-64' : 'w-0'} shrink-0 flex flex-col border-r border-white/[0.05] transition-all duration-300 overflow-hidden bg-[#0c0c0f]`}>

        {/* Logo area */}
        <div className="px-4 pt-5 pb-4 shrink-0 border-b border-white/[0.05]">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shrink-0 shadow-lg shadow-indigo-500/30">
              <Brain className="w-3.5 h-3.5 text-white"/>
            </div>
            <span className="font-bold text-[13px] text-white tracking-tight">MemoMind</span>
            <div className="ml-auto w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"/>
          </div>
          <button onClick={newChat}
            className="w-full flex items-center gap-2 bg-indigo-600/90 hover:bg-indigo-600 rounded-xl px-3 py-2 text-[13px] font-medium transition-all duration-200 shadow-md shadow-indigo-500/20 group">
            <Plus className="w-4 h-4 transition-transform group-hover:rotate-90 duration-200"/>
            New Chat
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-3 pt-3 gap-1 shrink-0">
          {[['chats','Chats',MessageSquare],['context','Context',Database]].map(([id,label,Icon])=>(
            <button key={id} onClick={()=>setTab(id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium transition-all
                ${activeTab===id ? 'bg-white/8 text-white' : 'text-slate-600 hover:text-slate-400'}`}>
              <Icon className="w-3 h-3"/>{label}
            </button>
          ))}
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/5">
          {activeTab === 'chats' && (
            chats.length === 0
              ? <div className="text-center py-10">
                  <MessageSquare className="w-6 h-6 mx-auto mb-2 text-slate-700"/>
                  <p className="text-[11px] text-slate-600">No chats yet</p>
                </div>
              : chats.map(c => (
                  <ChatItem key={c.chat_id} chat={c}
                    active={activeChat?.chat_id === c.chat_id}
                    onSelect={selectChat} onDelete={deleteChat} onRename={renameChat}/>
                ))
          )}

          {activeTab === 'context' && (
            <div className="space-y-2 pt-1">
              {webSearched && (
                <div className="flex items-center gap-2 bg-blue-500/8 border border-blue-500/15 rounded-xl px-3 py-2">
                  <span className="text-blue-400 text-sm">🌐</span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-blue-300">Web searched</p>
                    {searchQuery && <p className="text-[10px] text-slate-500 truncate">"{searchQuery}"</p>}
                  </div>
                </div>
              )}
              {detectedLang && detectedLang !== 'English' && (
                <div className="flex items-center gap-2 bg-violet-500/8 border border-violet-500/15 rounded-xl px-3 py-2">
                  <span className="text-[11px] text-violet-300">🌍 {detectedLang}</span>
                </div>
              )}
              {semMems.length === 0
                ? <div className="text-center py-8">
                    <Search className="w-6 h-6 mx-auto mb-2 text-slate-700"/>
                    <p className="text-[11px] text-slate-600">Cross-chat memories appear here</p>
                  </div>
                : semMems.map((m,i) => (
                    <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-md">
                          {((m.score||0)*100).toFixed(0)}%
                        </span>
                        <span className="text-[10px] text-slate-600 truncate">{m.chat_title||'Past chat'}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2">{m.content}</p>
                    </div>
                  ))
              }
            </div>
          )}
        </div>

        {/* User footer */}
        <div className="px-3 py-3 border-t border-white/[0.05] shrink-0">
          <div className="flex items-center gap-2.5 px-1">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center font-bold text-xs shrink-0 shadow-md">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold truncate">{user_name}</p>
              <p className="text-[10px] text-slate-600 truncate">{user.email}</p>
            </div>
            <button onClick={onLogout} title="Sign out"
              className="p-1.5 hover:bg-white/8 rounded-lg text-slate-600 hover:text-slate-400 transition-all">
              <LogOut className="w-3.5 h-3.5"/>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.05] bg-[#080809]/90 backdrop-blur-sm shrink-0">
          <button onClick={()=>setSidebar(v=>!v)}
            className="p-1.5 hover:bg-white/5 rounded-lg transition-all text-slate-500 hover:text-slate-300">
            {sidebar ? <X className="w-4 h-4"/> : <Menu className="w-4 h-4"/>}
          </button>
          <div className="flex-1 min-w-0 flex items-center gap-3">
            {activeChat
              ? <p className="font-semibold text-[14px] text-white truncate">{activeChat.title}</p>
              : <p className="text-slate-600 text-[14px]">Select or create a chat</p>}
            {activeChat && (
              <span className="text-[10px] text-emerald-400 bg-emerald-500/8 border border-emerald-500/15 px-2 py-1 rounded-full flex items-center gap-1.5 font-medium shrink-0">
                <span className="w-1 h-1 bg-emerald-400 rounded-full animate-pulse"/>
                Memory Active
              </span>
            )}
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/5">
          {/* Ambient glow */}
          <div className="fixed inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-600/[0.04] rounded-full blur-[140px]"/>
          </div>

          {!activeChat ? (
            <div className="h-full flex items-center justify-center relative z-10">
              <div className="text-center max-w-xs">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] mb-5">
                  <Brain className="w-7 h-7 text-indigo-400"/>
                </div>
                <h3 className="text-lg font-bold mb-1.5">Hey, {user_name} 👋</h3>
                <p className="text-slate-500 text-sm mb-5">Start a new chat or pick one from the sidebar.</p>
                <button onClick={newChat}
                  className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl px-4 py-2 text-[13px] font-semibold transition-all shadow-lg shadow-indigo-500/20">
                  <Plus className="w-4 h-4"/> New Chat
                </button>
              </div>
            </div>
          ) : messages.length === 0 && !typing ? (
            <div className="h-full flex items-center justify-center relative z-10">
              <div className="text-center max-w-xs">
                <MessageSquare className="w-10 h-10 text-slate-700 mx-auto mb-3"/>
                <p className="text-slate-500 text-sm">Send a message to begin.</p>
                <p className="text-slate-700 text-xs mt-1.5">MemoMind remembers across all your chats.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-6 relative z-10 max-w-3xl mx-auto">
              {messages.map((msg, i) => (
                <div key={msg.id||i} className={`flex ${msg.role==='user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`group/msg flex gap-3 ${msg.role==='user' ? 'flex-row-reverse max-w-[70%]' : 'max-w-[85%]'}`}>

                    {/* Avatar */}
                    <div className="shrink-0 mt-0.5">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold
                        ${msg.role==='user'
                          ? 'bg-gradient-to-br from-violet-500 to-indigo-500 shadow-md shadow-indigo-500/20'
                          : 'bg-white/[0.06] border border-white/[0.08]'}`}>
                        {msg.role==='user' ? initials : <Bot className="w-3.5 h-3.5 text-indigo-400"/>}
                      </div>
                    </div>

                    {/* Bubble + meta */}
                    <div className="min-w-0">
                      <div className={`rounded-2xl px-4 py-3
                        ${msg.role==='user'
                          ? 'bg-indigo-600 text-white rounded-tr-sm shadow-lg shadow-indigo-500/15'
                          : `rounded-tl-sm shadow-sm ${msg.isError
                              ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                              : 'bg-white/[0.04] border border-white/[0.07] text-slate-100'}`}`}
                        style={msg.role==='assistant' ? {fontFamily:'var(--chat-font,inherit)'} : {}}>
                        {msg.role==='user'
                          ? <p className="text-[14px] leading-relaxed">{msg.content}</p>
                          : <MarkdownWithCopy content={msg.content}/>}
                      </div>

                      {/* Timestamp + copy */}
                      <div className={`flex items-center gap-2 mt-1.5 ${msg.role==='user' ? 'justify-end' : 'justify-start'}`}>
                        {msg.role === 'assistant' && !msg.isError && (
                          <CopyButton text={msg.content}
                            className="opacity-0 group-hover/msg:opacity-100 transition-opacity duration-200"/>
                        )}
                        <span className="text-[10px] text-slate-700">{fmtTime(msg.timestamp)}</span>
                        {msg.role==='assistant' && detectedLang && detectedLang !== 'English' && (
                          <span className="text-[9px] text-indigo-500 bg-indigo-500/10 rounded px-1.5 py-0.5">{detectedLang}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {typing && (
                <div className="flex justify-start">
                  <div className="flex gap-3">
                    <div className="w-7 h-7 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-indigo-400"/>
                    </div>
                    <div className="bg-white/[0.04] border border-white/[0.07] rounded-2xl rounded-tl-sm px-5 py-3">
                      <TypingDots/>
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef}/>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-white/[0.05] bg-[#080809] px-4 py-3 shrink-0">
          <div className={`flex gap-2.5 max-w-3xl mx-auto transition-opacity ${!activeChat ? 'opacity-30 pointer-events-none' : ''}`}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&(e.preventDefault(),sendMessage())}
              placeholder={activeChat ? `Message ${activeChat.title}…` : 'Select a chat first'}
              disabled={busy||!activeChat}
              rows={1}
              className="flex-1 resize-none bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.12] focus:border-indigo-500/40 text-white placeholder-slate-600 rounded-xl px-4 py-3 text-[14px] focus:outline-none transition-all duration-200 leading-relaxed"
              style={{minHeight:'46px', maxHeight:'120px'}}
              onInput={e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,120)+'px';}}
            />
            <button onClick={sendMessage} disabled={busy||!input.trim()||!activeChat}
              className={`px-4 rounded-xl flex items-center justify-center transition-all duration-200 shrink-0 self-end mb-[0px]
                ${busy||!input.trim()||!activeChat
                  ? 'bg-white/5 text-slate-600 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'}`}
              style={{height:'46px'}}>
              <Send className="w-4 h-4"/>
            </button>
          </div>
          <p className="text-[10px] text-slate-700 text-center mt-2">
            Enter to send · Shift+Enter for newline · memories persist
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('memomind_user')); } catch { return null; }
  });
  const handleEnter = u => { localStorage.setItem('memomind_user', JSON.stringify(u)); setUser(u); };
  const handleLogout = () => { localStorage.removeItem('memomind_user'); setUser(null); };
  if (!user) return <AuthScreen onEnter={handleEnter}/>;
  return <ChatApp user={user} onLogout={handleLogout}/>;
}