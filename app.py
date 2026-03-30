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
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("""
        CREATE TABLE IF NOT EXISTS queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER,
            output_tokens INTEGER,
            FOREIGN KEY (query_id) REFERENCES queries(id) ON DELETE CASCADE
        )
    """)
    # Migrate existing tables that lack token columns
    try:
        db.execute("ALTER TABLE responses ADD COLUMN input_tokens INTEGER")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE responses ADD COLUMN output_tokens INTEGER")
    except sqlite3.OperationalError:
        pass
    db.execute("PRAGMA foreign_keys = ON")
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


def stream_claude(query, model="claude-sonnet-4-20250514"):
    """Yields text chunks, then a dict with usage info as the final item."""
    try:
        with claude_client.messages.stream(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": query}],
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


def _stream_openai_compat(client, query, model):
    """Shared streaming logic for OpenAI-compatible APIs (ChatGPT, Grok)."""
    try:
        stream = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": query}],
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


def stream_chatgpt(query, model="gpt-4o"):
    yield from _stream_openai_compat(openai_client, query, model)


def stream_grok(query, model="grok-3"):
    yield from _stream_openai_compat(grok_client, query, model)


@app.route("/api/stream/<provider>", methods=["POST"])
def stream_response(provider):
    data = request.get_json()
    query = data.get("query", "")
    query_id = data.get("query_id")
    if not query:
        return {"error": "No query provided"}, 400

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
        for chunk in gen_fn(query):
            if isinstance(chunk, dict):
                usage = chunk
                yield f"data: {json.dumps({'usage': usage})}\n\n"
            else:
                full_text.append(chunk)
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        # Save completed response and token usage to DB
        if query_id:
            try:
                db = sqlite3.connect(DB_PATH)
                db.execute("PRAGMA foreign_keys = ON")
                input_tokens = usage["input_tokens"] if usage else None
                output_tokens = usage["output_tokens"] if usage else None
                db.execute(
                    "UPDATE responses SET content = ?, input_tokens = ?, output_tokens = ? "
                    "WHERE query_id = ? AND provider = ?",
                    ("".join(full_text), input_tokens, output_tokens, query_id, provider),
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


@app.route("/api/query", methods=["POST"])
def create_query():
    """Create a new query record and empty response rows. Returns the query_id."""
    data = request.get_json()
    query = data.get("query", "").strip()
    if not query:
        return {"error": "No query provided"}, 400

    db = get_db()
    db.execute("PRAGMA foreign_keys = ON")
    now = datetime.now(timezone.utc).isoformat()
    cur = db.execute("INSERT INTO queries (query, created_at) VALUES (?, ?)", (query, now))
    query_id = cur.lastrowid
    for provider in ("claude", "chatgpt", "grok"):
        db.execute(
            "INSERT INTO responses (query_id, provider, content) VALUES (?, ?, '')",
            (query_id, provider),
        )
    db.commit()
    return jsonify({"query_id": query_id})


@app.route("/api/history")
def list_history():
    db = get_db()
    rows = db.execute("SELECT id, query, created_at FROM queries ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/history/<int:query_id>")
def get_history_entry(query_id):
    db = get_db()
    q = db.execute("SELECT id, query, created_at FROM queries WHERE id = ?", (query_id,)).fetchone()
    if not q:
        return {"error": "Not found"}, 404
    responses = db.execute(
        "SELECT provider, content, input_tokens, output_tokens FROM responses WHERE query_id = ?",
        (query_id,),
    ).fetchall()
    return jsonify({
        **dict(q),
        "responses": {r["provider"]: r["content"] for r in responses},
        "usage": {
            r["provider"]: {
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
            }
            for r in responses
        },
    })


@app.route("/api/history/<int:query_id>", methods=["DELETE"])
def delete_history_entry(query_id):
    db = get_db()
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("DELETE FROM queries WHERE id = ?", (query_id,))
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, port=5050)
