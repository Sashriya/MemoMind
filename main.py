from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from datetime import datetime
import os, re, httpx, json
from dotenv import load_dotenv
from groq import Groq
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct,
    Filter, FieldCondition, MatchValue
)
from uuid import uuid4
import logging
import numpy as np

load_dotenv()

app = FastAPI(title="MemoMind API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
TAVILY_KEY  = os.getenv("TAVILY_API_KEY", "")

# logging must be set up BEFORE qdrant init
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Qdrant: auto-clear stale lock then connect
import time, pathlib

def create_qdrant_client(data_path: str = "./qdrant_data") -> QdrantClient:
    try:
        return QdrantClient(path=data_path)
    except RuntimeError as e:
        if "already accessed" in str(e) or "AlreadyLocked" in str(e):
            print("[MemoMind] Qdrant lock detected — clearing stale lock files and retrying...")
            for lock_file in pathlib.Path(data_path).rglob("*.lock"):
                try:
                    lock_file.unlink()
                    print(f"[MemoMind] Removed: {lock_file}")
                except Exception as le:
                    print(f"[MemoMind] Could not remove {lock_file}: {le}")
            time.sleep(0.5)
            return QdrantClient(path=data_path)
        raise

qdrant = create_qdrant_client("./qdrant_data")



MESSAGES_COL = "chat_messages"
CHATS_COL    = "chats"
USERS_COL    = "users"
VECTOR_SIZE  = 384


def ensure_col(name: str):
    try:
        qdrant.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )
    except Exception:
        pass

for c in [MESSAGES_COL, CHATS_COL, USERS_COL]:
    ensure_col(c)


# ─── Models ──────────────────────────────────────────────────────────────────

class RegisterUser(BaseModel):
    user_name: str
    email: str

class CreateChat(BaseModel):
    user_id: str
    user_name: str
    title: str = "New Chat"

class RenameChat(BaseModel):
    title: str

class Message(BaseModel):
    content: str
    user_id: str
    user_name: str
    chat_id: str

class ChatResponse(BaseModel):
    response: str
    cross_chat_memories: List[Dict[str, Any]]
    current_chat_context: List[Dict[str, Any]]
    token_usage: Dict[str, int]
    model_used: str
    detected_language: str
    web_searched: bool
    search_query: Optional[str] = None


# ─── Embedding ───────────────────────────────────────────────────────────────

def embed(text: str) -> List[float]:
    words = text.lower().split()
    v = np.zeros(VECTOR_SIZE)
    for w in words:
        v[abs(hash(w)) % VECTOR_SIZE] += 1
    n = np.linalg.norm(v)
    return (v / n if n > 0 else v).tolist()


# ─── Qdrant helpers ──────────────────────────────────────────────────────────

def q_search(col: str, vector: List[float], f: Filter, limit: int) -> list:
    try:
        res = qdrant.query_points(
            collection_name=col, query=vector,
            query_filter=f, limit=limit, with_payload=True,
        )
        return res.points if hasattr(res, "points") else res
    except AttributeError:
        pass
    try:
        return qdrant.search(
            collection_name=col, query_vector=vector,
            query_filter=f, limit=limit, with_payload=True,
        )
    except Exception as e:
        logger.error(f"q_search: {e}")
        return []


def q_scroll(col: str, f: Filter, limit: int = 500) -> list:
    try:
        pts, _ = qdrant.scroll(
            collection_name=col, scroll_filter=f,
            limit=limit, with_payload=True, with_vectors=False,
        )
        return pts
    except Exception as e:
        logger.error(f"q_scroll: {e}")
        return []


def upsert(col: str, point: PointStruct):
    qdrant.upsert(collection_name=col, points=[point])


# ─── Language Detection ───────────────────────────────────────────────────────

# Map language name → native instruction string injected just before user message
LANG_INSTRUCTION = {
    "Tamil":   "முக்கியம்: இந்த பதிலை முழுவதும் தமிழிலேயே எழுது. வேறு எந்த மொழியும் வேண்டாம்.",
    "Hindi":   "महत्वपूर्ण: यह पूरा जवाब केवल हिंदी में दें। कोई अन्य भाषा नहीं।",
    "Arabic":  "مهم: اكتب هذه الإجابة كاملةً باللغة العربية فقط. لا تستخدم أي لغة أخرى.",
    "French":  "Important: Réponds entièrement en français. Aucune autre langue.",
    "Spanish": "Importante: Responde completamente en español. Sin mezclar idiomas.",
    "German":  "Wichtig: Antworte vollständig auf Deutsch. Keine andere Sprache.",
    "English": "Important: Reply entirely in English. No other language.",
}

def detect_language(text: str) -> str:
    """Unicode-range detection first, then word-frequency heuristics."""
    tamil   = sum(1 for c in text if "\u0B80" <= c <= "\u0BFF")
    hindi   = sum(1 for c in text if "\u0900" <= c <= "\u097F")
    arabic  = sum(1 for c in text if "\u0600" <= c <= "\u06FF")
    kannada = sum(1 for c in text if "\u0C80" <= c <= "\u0CFF")
    telugu  = sum(1 for c in text if "\u0C00" <= c <= "\u0C7F")
    total   = max(len(text), 1)
    if tamil   / total > 0.06: return "Tamil"
    if hindi   / total > 0.06: return "Hindi"
    if arabic  / total > 0.06: return "Arabic"
    if kannada / total > 0.06: return "Kannada"
    if telugu  / total > 0.06: return "Telugu"

    # Romanised Tamil heuristics (people typing Tamil in English letters)
    rom_tamil = {
        "naan","nee","avan","aval","enna","epdi","eppdi","sollu","solu",
        "paru","po","va","vaa","iruken","iruku","irukka","irukken",
        "pannuven","seri","aama","ille","illai","illa",
        "machan","da","di","thambi","akka","appa","amma","anna",
        "vandhu","vandhuten","kittu","unaku","enaku","kelunga","parunga",
        "yenna","yepdi","yeppdi","solren","solluven","sollunga",
        "theriyum","therila","puriyuthu","puriyala","puriala",
        "enna","endha","eppo","eppadhi","ivlo","avlo",
        "konjam","romba","mikka","vera","vera","adhuve",
        "naanga","neenga","avanga","ingaye","angaye",
        "poiduven","poren","varen","solli","pakka","paakka",
        "irukkinga","irukkanga","irukkoma","irukkom",
        "theriuma","theriyuma","solla","kekkanum","kekkurom",
        "kathunga","sollunga","parunga","kelunga",
    }
    words = set(text.lower().split())
    if len(words & rom_tamil) >= 1: return "Tamil (Romanised)"

    if len(words & {"je","tu","il","nous","vous","bonjour","merci","oui","non","est","une"}) >= 2: return "French"
    if len(words & {"hola","como","esta","gracias","que","por","buenos","favor"})             >= 2: return "Spanish"
    if len(words & {"ich","du","ist","und","die","der","das","nicht","bitte","danke"})        >= 2: return "German"
    return "English"


# ─── Web Search (Tavily) ─────────────────────────────────────────────────────

# Keywords that strongly suggest real-time / current-affairs need
_LIVE_PATTERNS = re.compile(
    r'\b(today|tonight|yesterday|this week|this month|this year|latest|recent|'
    r'current|now|live|ongoing|breaking|just|update|score|winner|result|'
    r'election|match|game|weather|price|stock|rate|news|happened|announced|'
    r'released|launched|died|arrested|won|lost|crisis|war|flood|earthquake|'
    r'budget|policy|bill|law|passed|verdict|trial|'
    # Tamil transliterations
    r'ippo|indha naal|iniku|ithu naal|nadakuthu|nadanthadu|'
    # Hindi
    r'aaj|abhi|kal|is hafte|taaza|khabar)\b',
    re.IGNORECASE
)

def needs_web_search(text: str) -> bool:
    """Decide whether the question needs a live web search."""
    return bool(_LIVE_PATTERNS.search(text))


async def web_search(query: str, max_results: int = 5) -> Dict[str, Any]:
    """
    Search via Tavily API (fast, summarised results).
    Falls back to a DuckDuckGo instant-answer if no Tavily key.
    Returns {"results": [...], "source": "tavily"|"ddg"|"none"}
    """
    # ── Tavily ──────────────────────────────────────────────────────────────
    if TAVILY_KEY:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.post(
                    "https://api.tavily.com/search",
                    json={
                        "api_key": TAVILY_KEY,
                        "query": query,
                        "search_depth": "basic",
                        "max_results": max_results,
                        "include_answer": True,
                    },
                )
            data = r.json()
            results = []
            # Use the direct answer if present
            if data.get("answer"):
                results.append({"title": "Summary", "snippet": data["answer"], "url": ""})
            for item in data.get("results", [])[:max_results]:
                results.append({
                    "title":   item.get("title", ""),
                    "snippet": item.get("content", "")[:300],
                    "url":     item.get("url", ""),
                })
            return {"results": results, "source": "tavily"}
        except Exception as e:
            logger.warning(f"Tavily error: {e}")

    # ── DuckDuckGo instant answer (no-key fallback) ───────────────────────
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
                headers={"User-Agent": "MemoMind/1.0"},
            )
        data = r.json()
        results = []
        if data.get("AbstractText"):
            results.append({"title": data.get("Heading",""), "snippet": data["AbstractText"], "url": data.get("AbstractURL","")})
        for topic in data.get("RelatedTopics", [])[:3]:
            if isinstance(topic, dict) and topic.get("Text"):
                results.append({"title": "", "snippet": topic["Text"][:250], "url": topic.get("FirstURL","")})
        if results:
            return {"results": results, "source": "ddg"}
    except Exception as e:
        logger.warning(f"DDG fallback error: {e}")

    return {"results": [], "source": "none"}


def format_search_results(data: Dict[str, Any]) -> str:
    results = data.get("results", [])
    if not results:
        return ""
    lines = ["LIVE WEB SEARCH RESULTS:"]
    for i, r in enumerate(results, 1):
        title = f"[{r['title']}] " if r.get("title") else ""
        lines.append(f"{i}. {title}{r['snippet']}")
        if r.get("url"):
            lines.append(f"   Source: {r['url']}")
    return "\n".join(lines)


# ─── Users ───────────────────────────────────────────────────────────────────

@app.post("/users/register")
async def register_user(body: RegisterUser):
    name  = body.user_name.strip()
    email = body.email.strip().lower()
    if not name or not email:
        raise HTTPException(400, "Name and email required")
    f = Filter(must=[FieldCondition(key="email", match=MatchValue(value=email))])
    hits = q_scroll(USERS_COL, f, limit=1)
    if hits:
        p = hits[0].payload
        return {"user_id": p["user_id"], "user_name": p["user_name"],
                "email": p["email"], "is_new": False}
    user_id = f"u_{uuid4().hex[:10]}"
    upsert(USERS_COL, PointStruct(
        id=str(uuid4()), vector=embed(email),
        payload={"user_id": user_id, "user_name": name, "email": email,
                 "created_at": datetime.now().isoformat()},
    ))
    return {"user_id": user_id, "user_name": name, "email": email, "is_new": True}


# ─── Chats ───────────────────────────────────────────────────────────────────

@app.post("/chats")
async def create_chat(body: CreateChat):
    chat_id = f"chat_{uuid4().hex[:10]}"
    now = datetime.now().isoformat()
    upsert(CHATS_COL, PointStruct(
        id=str(uuid4()), vector=embed(body.title),
        payload={"chat_id": chat_id, "user_id": body.user_id,
                 "user_name": body.user_name, "title": body.title,
                 "created_at": now, "updated_at": now, "message_count": 0},
    ))
    return {"chat_id": chat_id, "title": body.title, "created_at": now}


@app.get("/chats/{user_id}")
async def get_user_chats(user_id: str):
    f = Filter(must=[FieldCondition(key="user_id", match=MatchValue(value=user_id))])
    pts = q_scroll(CHATS_COL, f)
    chats = [
        {"chat_id": p.payload["chat_id"], "title": p.payload.get("title", "Chat"),
         "created_at": p.payload.get("created_at"), "updated_at": p.payload.get("updated_at"),
         "message_count": p.payload.get("message_count", 0)}
        for p in pts
    ]
    chats.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return {"chats": chats}


@app.patch("/chats/{chat_id}")
async def rename_chat(chat_id: str, body: RenameChat):
    f = Filter(must=[FieldCondition(key="chat_id", match=MatchValue(value=chat_id))])
    pts = q_scroll(CHATS_COL, f, limit=1)
    if not pts:
        raise HTTPException(404, "Chat not found")
    p = pts[0]
    upsert(CHATS_COL, PointStruct(
        id=str(p.id), vector=embed(body.title),
        payload={**p.payload, "title": body.title,
                 "updated_at": datetime.now().isoformat()},
    ))
    return {"chat_id": chat_id, "title": body.title}


@app.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str):
    f = Filter(must=[FieldCondition(key="chat_id", match=MatchValue(value=chat_id))])
    msgs = q_scroll(MESSAGES_COL, f)
    if msgs:
        qdrant.delete(collection_name=MESSAGES_COL,
                      points_selector=[str(p.id) for p in msgs])
    cf = Filter(must=[FieldCondition(key="chat_id", match=MatchValue(value=chat_id))])
    cpts = q_scroll(CHATS_COL, cf, limit=1)
    if cpts:
        qdrant.delete(collection_name=CHATS_COL, points_selector=[str(cpts[0].id)])
    return {"status": "deleted"}


# ─── Messages ────────────────────────────────────────────────────────────────

def get_chat_messages(chat_id: str, limit: int = 60) -> List[Dict]:
    f = Filter(must=[FieldCondition(key="chat_id", match=MatchValue(value=chat_id))])
    pts = q_scroll(MESSAGES_COL, f, limit=limit)
    msgs = [
        {"id": str(p.id), "chat_id": p.payload.get("chat_id"),
         "role": p.payload.get("role"), "content": p.payload.get("content"),
         "timestamp": p.payload.get("timestamp"),
         "chat_title": p.payload.get("chat_title", "")}
        for p in pts
    ]
    msgs.sort(key=lambda x: x["timestamp"] or "")
    return msgs


def store_message(chat_id: str, chat_title: str, user_id: str,
                  user_name: str, role: str, content: str):
    upsert(MESSAGES_COL, PointStruct(
        id=str(uuid4()), vector=embed(content),
        payload={"chat_id": chat_id, "chat_title": chat_title,
                 "user_id": user_id, "user_name": user_name,
                 "role": role, "content": content,
                 "timestamp": datetime.now().isoformat()},
    ))


def update_chat_meta(chat_id: str, new_title: Optional[str] = None):
    f = Filter(must=[FieldCondition(key="chat_id", match=MatchValue(value=chat_id))])
    pts = q_scroll(CHATS_COL, f, limit=1)
    if not pts:
        return
    p   = pts[0]
    old = p.payload
    title = new_title if new_title else old.get("title", "Chat")
    upsert(CHATS_COL, PointStruct(
        id=str(p.id), vector=embed(title),
        payload={**old, "title": title,
                 "message_count": old.get("message_count", 0) + 1,
                 "updated_at": datetime.now().isoformat()},
    ))


def get_cross_chat_memories(user_id: str, current_chat_id: str,
                            query: str, limit: int = 6) -> List[Dict]:
    f = Filter(must=[FieldCondition(key="user_id", match=MatchValue(value=user_id))])
    hits = q_search(MESSAGES_COL, embed(query), f, limit=limit + 10)
    memories = []
    for h in hits:
        if h.payload.get("chat_id") == current_chat_id:
            continue
        memories.append({
            "content":    h.payload.get("content"),
            "timestamp":  h.payload.get("timestamp"),
            "role":       h.payload.get("role"),
            "chat_title": h.payload.get("chat_title", "Previous Chat"),
            "chat_id":    h.payload.get("chat_id"),
            "score":      getattr(h, "score", 0.0),
        })
        if len(memories) >= limit:
            break
    return memories


@app.get("/messages/{chat_id}")
async def get_messages(chat_id: str):
    return {"messages": get_chat_messages(chat_id)}


# ─── Chat (AI) ───────────────────────────────────────────────────────────────

@app.post("/chat", response_model=ChatResponse)
async def chat(msg: Message):
    logger.info(f"Chat [{msg.chat_id}] from {msg.user_name}")

    # 1. Current thread + cross-chat memories
    history    = get_chat_messages(msg.chat_id, limit=40)
    cross_mems = get_cross_chat_memories(msg.user_id, msg.chat_id, msg.content, limit=6)

    # 2. Language detection
    detected_lang = detect_language(msg.content)

    # 3. Current chat title
    cf = Filter(must=[FieldCondition(key="chat_id", match=MatchValue(value=msg.chat_id))])
    chat_pts = q_scroll(CHATS_COL, cf, limit=1)
    current_chat_title = chat_pts[0].payload.get("title", "this chat") if chat_pts else "this chat"

    # 4. Web search if needed
    searched      = False
    search_query  = None
    search_block  = ""

    if needs_web_search(msg.content):
        # Build a clean English search query from the user message
        # Ask the LLM quickly to extract the search query
        try:
            sq_resp = groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content":
                        "Extract a concise web search query (English, max 10 words) "
                        "from the user's question. Reply with ONLY the search query, nothing else."},
                    {"role": "user", "content": msg.content}
                ],
                temperature=0,
                max_tokens=30,
            )
            search_query = sq_resp.choices[0].message.content.strip().strip('"')
        except Exception:
            search_query = msg.content[:100]

        search_data  = await web_search(search_query)
        search_block = format_search_results(search_data)
        searched     = bool(search_block)
        logger.info(f"Web search [{search_data['source']}]: {search_query}")

    # 5. Cross-chat context block
    cross_ctx = ""
    if cross_mems:
        cross_ctx = "MEMORIES FROM OTHER CONVERSATIONS:\n"
        by_chat: Dict[str, List] = {}
        for m in cross_mems:
            key = m.get("chat_title") or "Previous Chat"
            by_chat.setdefault(key, []).append(m)
        for ct, mems in by_chat.items():
            cross_ctx += f'  From "{ct}":\n'
            for m in mems[:3]:
                cross_ctx += f"    [{m['role']}] {m['content']}\n"
        cross_ctx += "\n"

    # 6. Continuation flag
    is_continuation = any(w in msg.content.lower() for w in [
        "continue", "tell more", "elaborate", "and then", "what else",
        "go on", "more about", "keep going", "finish", "thodaru",
        "மேலும்", "தொடர்",
    ])

    # 7. Build context for the answer
    today = datetime.now().strftime("%d %B %Y")

    # ── Step 1: Generate answer in English (llama is best in English) ─────────
    english_system = f"""You are MemoMind, a helpful AI assistant with memory across conversations.
You are talking to {msg.user_name}. Today is {today}.

{cross_ctx}{search_block}IDENTITY — never break character:
- You are MemoMind. You are multilingual. You understand and help with ALL topics in ALL languages.
- You NEVER say "I can only speak English", "I don't understand Tamil", or any language refusal.
- If user asks anything — casual, personal, factual — just answer it helpfully.
- You have no language restrictions. You help everyone regardless of what language they write in.

TONE:
- Mature and direct. No filler phrases like "Great!", "Sure!", "Certainly!".
- Talk like a knowledgeable friend — warm but not over the top.
- Keep answers concise unless detail is needed.
- {'Continue from exactly where you left off.' if is_continuation else 'Answer directly.'}

MEMORY:
- Use cross-chat context when relevant. Say "You mentioned earlier…" naturally.
- Never fabricate memories.

CONTENT:
- If web search data is above, use it for current affairs / recent info.
- If you don't know something, say so simply — don't refuse to engage.

Answer in English in this internal step — your answer will be translated automatically.
"""

    # Phrases that indicate model previously refused / claimed English-only
    # These corrupt context — strip them out
    REFUSAL_PATTERNS = [
        "i can only respond in english",
        "i can understand and respond in",
        "i don't understand tamil",
        "i cannot respond in tamil",
        "i don't speak tamil",
        "only one language, which is english",
        "i only speak english",
        "i'm unable to respond in tamil",
        "i can only communicate in english",
        "i'm not able to understand",
        "you'd like to discuss in english",
        "i'm here to help with any questions or topics you'd like to discuss in english",
        "i am responding in tamil",
        "i am providing a response in tamil",
        "நன்றாக தமிழ் புரியவில்லை",
        "தமிழ் மொழியைப் புரிந்து கொள்ளாததால்",
        "ஆங்கிலத்தில் பேச விரும்புகிறேன்",
        "எங்கள் முந்தைய உரையாடலின்படி",
    ]

    def is_refusal(text: str) -> bool:
        t = (text or "").lower()
        return any(p in t for p in REFUSAL_PATTERNS)

    # Also detect session language — if recent user messages were non-English,
    # treat short ambiguous messages ("Hi", "Ok", "Yes") as same language
    recent_user_langs = []
    for h in history[-10:]:
        if h["role"] == "user":
            lang = detect_language(h["content"])
            if lang != "English":
                recent_user_langs.append(lang)

    # Override detected_lang for short/ambiguous messages
    SHORT_AMBIGUOUS = {"hi","hello","ok","okay","yes","no","thanks","thank you",
                       "sure","good","nice","wow","cool","great","fine","alright",
                       "lol","haha","bye","see you","👍","👎","😊"}
    if detected_lang == "English" and recent_user_langs:
        msg_words = set(msg.content.lower().strip().split())
        if msg_words.issubset(SHORT_AMBIGUOUS) or len(msg.content.strip()) <= 6:
            detected_lang = recent_user_langs[-1]  # continue in session language
            logger.info(f"Short message detected — using session language: {detected_lang}")

    groq_msgs = [{"role": "system", "content": english_system}]
    for h in history[-20:]:
        if h["role"] == "assistant" and is_refusal(h["content"]):
            # Replace refusal with a neutral placeholder so context flow isn't broken
            groq_msgs.append({"role": "assistant", "content": "I understand. Let me help you with that."})
        else:
            groq_msgs.append({"role": h["role"], "content": h["content"]})
    groq_msgs.append({"role": "user", "content": msg.content})

    try:
        # Step 1 call — get English answer
        step1 = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=groq_msgs,
            temperature=0.4,
            max_tokens=700,
        )
        english_answer = step1.choices[0].message.content.strip()

        # ── Step 2: Translate to target language if not English ───────────────
        if detected_lang not in ("English",):
            lang_name_map = {
                "Tamil":             "Tamil (தமிழ்)",
                "Tamil (Romanised)": "Tamil (தமிழ்)",
                "Hindi":             "Hindi (हिंदी)",
                "Arabic":            "Arabic (عربي)",
                "French":            "French (Français)",
                "Spanish":           "Spanish (Español)",
                "German":            "German (Deutsch)",
                "Kannada":           "Kannada (ಕನ್ನಡ)",
                "Telugu":            "Telugu (తెలుగు)",
            }
            target = lang_name_map.get(detected_lang, detected_lang)

            translate_msgs = [
                {
                    "role": "system",
                    "content": (
                        f"You are an expert translator. Translate English text to {target}.\n"
                        f"STRICT RULES:\n"
                        f"- Output ONLY the {target} translation.\n"
                        f"- Zero English words in output (except proper nouns/names/numbers).\n"
                        f"- No preamble, no labels, no explanations.\n"
                        f"- Natural conversational {target}, not formal/stiff.\n"
                        f"- Preserve formatting (lists, paragraphs)."
                    )
                },
                {
                    "role": "user",
                    "content": english_answer
                }
            ]

            step2 = groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=translate_msgs,
                temperature=0.1,
                max_tokens=900,
            )
            reply = step2.choices[0].message.content.strip()
            
            # Safety check — if output still contains mostly English, log warning
            eng_ratio = sum(1 for c in reply if c.isascii() and c.isalpha()) / max(len(reply), 1)
            if eng_ratio > 0.6:
                logger.warning(f"Translation may have failed (eng_ratio={eng_ratio:.2f}), using as-is")

            # Merge token usage
            total_tokens = {
                "input":  step1.usage.prompt_tokens + step2.usage.prompt_tokens,
                "output": step1.usage.completion_tokens + step2.usage.completion_tokens,
                "total":  step1.usage.total_tokens + step2.usage.total_tokens,
            }
        else:
            reply = english_answer
            total_tokens = {
                "input":  step1.usage.prompt_tokens,
                "output": step1.usage.completion_tokens,
                "total":  step1.usage.total_tokens,
            }

        # 9. Store
        store_message(msg.chat_id, current_chat_title,
                      msg.user_id, msg.user_name, "user", msg.content)
        store_message(msg.chat_id, current_chat_title,
                      msg.user_id, msg.user_name, "assistant", reply)

        # 10. Auto-title
        auto_title = None
        if len(history) == 0:
            auto_title = msg.content[:50] + ("…" if len(msg.content) > 50 else "")
        update_chat_meta(msg.chat_id, auto_title)

        return ChatResponse(
            response=reply,
            cross_chat_memories=cross_mems[:5],
            current_chat_context=[
                {"role": h["role"], "content": h["content"][:80]}
                for h in history[-5:]
            ],
            token_usage=total_tokens,
            model_used="llama-3.3-70b-versatile",
            detected_language=detected_lang,
            web_searched=searched,
            search_query=search_query,
        )
    except Exception as e:
        logger.error(f"Groq error: {e}", exc_info=True)
        raise HTTPException(500, str(e))


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "model": "Groq Llama 3.3 70B",
        "db": "Qdrant",
        "web_search": "Tavily" if TAVILY_KEY else "DuckDuckGo (fallback)",
    }