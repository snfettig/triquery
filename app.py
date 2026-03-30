import os
import json
import sqlite3
from datetime import datetime, timezone
from flask import Flask, render_template, request, Response, stream_with_context, jsonify, g
from dotenv import load_dotenv
import anthropic
import openai
import httpx

load_dotenv()

app = Flask(__name__)
DB_PATH = os.path.join(os.path.dirname(__file__), "history.db")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER,
            output_tokens INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )
    """)
    # Migrate old schema if it exists
    try:
        old_queries = db.execute("SELECT id, query, created_at FROM queries ORDER BY id").fetchall()
        if old_queries:
            for oq in old_queries:
                cur = db.execute(
                    "INSERT INTO conversations (title, created_at) VALUES (?, ?)",
                    (oq[1][:100], oq[2]),
                )
                conv_id = cur.lastrowid
                old_responses = db.execute(
                    "SELECT provider, content, input_tokens, output_tokens FROM responses WHERE query_id = ?",
                    (oq[0],),
                ).fetchall()
                for r in old_responses:
                    provider = r[0]
                    # Insert user message
                    db.execute(
                        "INSERT INTO messages (conversation_id, provider, role, content, created_at) "
                        "VALUES (?, ?, 'user', ?, ?)",
                        (conv_id, provider, oq[1], oq[2]),
                    )
                    # Insert assistant message
                    db.execute(
                        "INSERT INTO messages (conversation_id, provider, role, content, input_tokens, output_tokens, created_at) "
                        "VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
                        (conv_id, provider, r[1], r[2], r[3], oq[2]),
                    )
            db.execute("DROP TABLE responses")
            db.execute("DROP TABLE queries")
    except sqlite3.OperationalError:
        pass
    db.commit()
    db.close()


init_db()

claude_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
openai_client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
grok_client = openai.OpenAI(
    api_key=os.getenv("XAI_API_KEY"),
    base_url="https://api.x.ai/v1",
)


@app.route("/")
def index():
    return render_template("index.html")


def stream_claude(messages, model="claude-sonnet-4-20250514"):
    """Yields text chunks, then a dict with usage info as the final item."""
    try:
        with claude_client.messages.stream(
            model=model,
            max_tokens=4096,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                yield text
            msg = stream.get_final_message()
            yield {
                "input_tokens": msg.usage.input_tokens,
                "output_tokens": msg.usage.output_tokens,
            }
    except Exception as e:
        yield f"\n\n[Error: {e}]"


def _stream_openai_compat(client, messages, model):
    """Shared streaming logic for OpenAI-compatible APIs (ChatGPT, Grok)."""
    try:
        stream = client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
            if chunk.usage:
                yield {
                    "input_tokens": chunk.usage.prompt_tokens,
                    "output_tokens": chunk.usage.completion_tokens,
                }
    except Exception as e:
        yield f"\n\n[Error: {e}]"


def stream_chatgpt(messages, model="gpt-4o"):
    yield from _stream_openai_compat(openai_client, messages, model)


def stream_grok(messages, model="grok-3"):
    yield from _stream_openai_compat(grok_client, messages, model)


@app.route("/api/stream/<provider>", methods=["POST"])
def stream_response(provider):
    data = request.get_json()
    conversation_id = data.get("conversation_id")
    messages_for_api = data.get("messages", [])
    if not messages_for_api:
        return {"error": "No messages provided"}, 400

    generators = {
        "claude": stream_claude,
        "chatgpt": stream_chatgpt,
        "grok": stream_grok,
    }

    gen_fn = generators.get(provider)
    if not gen_fn:
        return {"error": f"Unknown provider: {provider}"}, 400

    def generate():
        full_text = []
        usage = None
        for chunk in gen_fn(messages_for_api):
            if isinstance(chunk, dict):
                usage = chunk
                yield f"data: {json.dumps({'usage': usage})}\n\n"
            else:
                full_text.append(chunk)
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        # Save assistant response to DB
        if conversation_id:
            try:
                db = sqlite3.connect(DB_PATH)
                db.execute("PRAGMA foreign_keys = ON")
                now = datetime.now(timezone.utc).isoformat()
                input_tokens = usage["input_tokens"] if usage else None
                output_tokens = usage["output_tokens"] if usage else None
                db.execute(
                    "INSERT INTO messages (conversation_id, provider, role, content, input_tokens, output_tokens, created_at) "
                    "VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
                    (conversation_id, provider, "".join(full_text), input_tokens, output_tokens, now),
                )
                db.commit()
                db.close()
            except Exception:
                pass
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/conversation", methods=["POST"])
def create_conversation():
    """Create a new conversation and initial user messages for all providers."""
    data = request.get_json()
    query = data.get("query", "").strip()
    if not query:
        return {"error": "No query provided"}, 400

    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    cur = db.execute(
        "INSERT INTO conversations (title, created_at) VALUES (?, ?)",
        (query[:100], now),
    )
    conversation_id = cur.lastrowid
    for provider in ("claude", "chatgpt", "grok"):
        db.execute(
            "INSERT INTO messages (conversation_id, provider, role, content, created_at) "
            "VALUES (?, ?, 'user', ?, ?)",
            (conversation_id, provider, query, now),
        )
    db.commit()
    return jsonify({"conversation_id": conversation_id})


@app.route("/api/conversation/<int:conv_id>/followup", methods=["POST"])
def add_followup(conv_id):
    """Add a user follow-up message to specific providers."""
    data = request.get_json()
    query = data.get("query", "").strip()
    target_providers = data.get("providers", [])
    if not query or not target_providers:
        return {"error": "query and providers required"}, 400

    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    for provider in target_providers:
        if provider in ("claude", "chatgpt", "grok"):
            db.execute(
                "INSERT INTO messages (conversation_id, provider, role, content, created_at) "
                "VALUES (?, ?, 'user', ?, ?)",
                (conv_id, provider, query, now),
            )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/history")
def list_history():
    db = get_db()
    rows = db.execute(
        "SELECT id, title, created_at FROM conversations ORDER BY id DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/history/<int:conv_id>")
def get_history_entry(conv_id):
    db = get_db()
    conv = db.execute(
        "SELECT id, title, created_at FROM conversations WHERE id = ?", (conv_id,)
    ).fetchone()
    if not conv:
        return {"error": "Not found"}, 404
    msgs = db.execute(
        "SELECT provider, role, content, input_tokens, output_tokens "
        "FROM messages WHERE conversation_id = ? ORDER BY id",
        (conv_id,),
    ).fetchall()
    # Group messages by provider, preserving order
    by_provider = {"claude": [], "chatgpt": [], "grok": []}
    for m in msgs:
        entry = {
            "role": m["role"],
            "content": m["content"],
        }
        if m["role"] == "assistant":
            entry["input_tokens"] = m["input_tokens"]
            entry["output_tokens"] = m["output_tokens"]
        by_provider.setdefault(m["provider"], []).append(entry)
    return jsonify({**dict(conv), "messages": by_provider})


@app.route("/api/history/<int:conv_id>", methods=["DELETE"])
def delete_history_entry(conv_id):
    db = get_db()
    db.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, port=5050)
