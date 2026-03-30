# TriQuery - Multi-AI Search

TriQuery sends a single query to **Claude**, **ChatGPT**, and **Grok** simultaneously and displays their streaming responses side-by-side in three resizable panes.

## Features

- **Parallel streaming** — all three AI responses stream in real time
- **Resizable panes** — drag dividers between panes to resize, or use toolbar buttons to equalize, focus, or hide individual panes
- **Query history** — all queries and responses are saved to a local SQLite database; browse, reload, or delete past entries from the history sidebar
- **System theme support** — automatically follows your macOS light/dark appearance
- **Markdown rendering** — responses render with full markdown support including code blocks, tables, and lists

## Requirements

- **macOS** (tested on macOS Sequoia / Apple Silicon)
- **Python 3.10+**
- **Homebrew** (for installing Python if needed)
- API keys for all three services:
  - [Anthropic (Claude)](https://console.anthropic.com/) — requires funded API account
  - [OpenAI (ChatGPT)](https://platform.openai.com/api-keys) — requires funded API account
  - [xAI (Grok)](https://console.x.ai/) — requires funded API account

> **Note:** Consumer subscriptions to ChatGPT, Claude, or X/Grok do **not** include API access. You must add billing/credits to each provider's API platform separately.

## Installation on macOS

1. **Clone the repository:**

   ```bash
   git clone https://github.com/snfettig/triquery.git
   cd triquery
   ```

2. **Create a Python virtual environment and install dependencies:**

   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Configure your API keys:**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and replace the placeholder values with your actual API keys:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   OPENAI_API_KEY=sk-proj-...
   XAI_API_KEY=xai-...
   ```

4. **Run the server:**

   ```bash
   source venv/bin/activate
   python app.py
   ```

5. **Open your browser** to [http://localhost:5050](http://localhost:5050)

## Usage

- Type a query and press **Enter** (or click **Send**) to query all three AIs at once
- Use **Shift+Enter** for multi-line queries
- **Toolbar controls:**
  - **Equal** — reset all panes to equal width
  - **Claude / ChatGPT / Grok** — expand one pane and shrink the others
  - **Hide/Show** — toggle individual panes on or off
- **Drag** the dividers between panes to resize freely
- Click **History** to open the sidebar, browse past queries, or delete individual entries

## Configuration

The default models can be changed in `app.py`:

- Claude: `claude-sonnet-4-20250514` (in `stream_claude`)
- ChatGPT: `gpt-4o` (in `stream_chatgpt`)
- Grok: `grok-3` (in `stream_grok`)

## Project Structure

```
├── app.py              # Flask backend with streaming API endpoints and history
├── requirements.txt    # Python dependencies
├── .env.example        # API key template (copy to .env)
├── templates/
│   └── index.html      # Main page template
└── static/
    ├── style.css       # Styling with light/dark theme support
    └── app.js          # Frontend logic: streaming, panes, history
```

Query history is stored in `history.db` (SQLite), created automatically on first run.
