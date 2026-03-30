// State
const providers = ['claude', 'chatgpt', 'grok'];
const rawText = { claude: '', chatgpt: '', grok: '' };
const paneVisible = { claude: true, chatgpt: true, grok: true };
let activeStreams = 0;
let currentQueryId = null;
let historyOpen = false;

// Elements
const form = document.getElementById('query-form');
const input = document.getElementById('query-input');
const sendBtn = document.getElementById('send-btn');

// Submit on Enter (Shift+Enter for newline)
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit'));
    }
});

// Form submit
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query || activeStreams > 0) return;

    sendBtn.disabled = true;
    activeStreams = 3;

    // Clear all panes
    providers.forEach(p => {
        rawText[p] = '';
        document.getElementById(`content-${p}`).innerHTML =
            '<div class="streaming-cursor"></div>';
        document.getElementById(`status-${p}`).textContent = 'streaming...';
    });

    // Create a DB record for this query
    try {
        const res = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await res.json();
        currentQueryId = data.query_id;
    } catch {
        currentQueryId = null;
    }

    // Fire all three streams concurrently
    providers.forEach(p => streamFrom(p, query, currentQueryId));

    // Refresh history sidebar
    loadHistory();
});

async function streamFrom(provider, query, queryId) {
    const contentEl = document.getElementById(`content-${provider}`);
    const statusEl = document.getElementById(`status-${provider}`);

    try {
        const res = await fetch(`/api/stream/${provider}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, query_id: queryId }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const payload = line.slice(6);
                    if (payload === '[DONE]') continue;
                    try {
                        const data = JSON.parse(payload);
                        if (data.text) {
                            rawText[provider] += data.text;
                            renderMarkdown(provider);
                        }
                    } catch {}
                }
            }
        }

        statusEl.textContent = 'done';
    } catch (err) {
        statusEl.textContent = 'error';
        rawText[provider] += `\n\n[Connection error: ${err.message}]`;
        renderMarkdown(provider);
    }

    activeStreams--;
    if (activeStreams <= 0) {
        sendBtn.disabled = false;
        activeStreams = 0;
    }
}

function renderMarkdown(provider) {
    const contentEl = document.getElementById(`content-${provider}`);
    const isAtBottom = contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight < 40;

    contentEl.innerHTML = marked.parse(rawText[provider]);

    // Add streaming cursor if still active
    const statusEl = document.getElementById(`status-${provider}`);
    if (statusEl.textContent === 'streaming...') {
        contentEl.classList.add('streaming-cursor');
    } else {
        contentEl.classList.remove('streaming-cursor');
    }

    // Auto-scroll if near bottom
    if (isAtBottom) {
        contentEl.scrollTop = contentEl.scrollHeight;
    }
}

// ---- History ----

function toggleHistory() {
    historyOpen = !historyOpen;
    const sidebar = document.getElementById('history-sidebar');
    const btn = document.getElementById('history-toggle');
    sidebar.classList.toggle('hidden', !historyOpen);
    btn.classList.toggle('active', historyOpen);
    if (historyOpen) loadHistory();
}

async function loadHistory() {
    const listEl = document.getElementById('history-list');
    try {
        const res = await fetch('/api/history');
        const items = await res.json();
        if (items.length === 0) {
            listEl.innerHTML = '<div class="history-empty">No queries yet</div>';
            return;
        }
        listEl.innerHTML = items.map(item => {
            const date = new Date(item.created_at);
            const dateStr = date.toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const isActive = item.id === currentQueryId ? ' active' : '';
            return `
                <div class="history-item${isActive}" data-id="${item.id}" onclick="loadHistoryEntry(${item.id})">
                    <div class="history-item-content">
                        <div class="history-item-query">${escapeHtml(item.query)}</div>
                        <div class="history-item-date">${dateStr}</div>
                    </div>
                    <button class="history-delete-btn" onclick="event.stopPropagation(); deleteHistoryEntry(${item.id})" title="Delete">&#x2715;</button>
                </div>
            `;
        }).join('');
    } catch {
        listEl.innerHTML = '<div class="history-empty">Failed to load history</div>';
    }
}

async function loadHistoryEntry(id) {
    if (activeStreams > 0) return;

    try {
        const res = await fetch(`/api/history/${id}`);
        const data = await res.json();
        currentQueryId = data.id;
        input.value = data.query;

        providers.forEach(p => {
            rawText[p] = data.responses[p] || '';
            const contentEl = document.getElementById(`content-${p}`);
            const statusEl = document.getElementById(`status-${p}`);
            if (rawText[p]) {
                contentEl.innerHTML = marked.parse(rawText[p]);
                statusEl.textContent = 'done';
            } else {
                contentEl.innerHTML = '<div class="placeholder">No response recorded</div>';
                statusEl.textContent = '';
            }
            contentEl.classList.remove('streaming-cursor');
        });

        // Highlight active item
        document.querySelectorAll('.history-item').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.id) === id);
        });
    } catch {}
}

async function deleteHistoryEntry(id) {
    try {
        await fetch(`/api/history/${id}`, { method: 'DELETE' });
        if (currentQueryId === id) {
            currentQueryId = null;
            providers.forEach(p => {
                rawText[p] = '';
                document.getElementById(`content-${p}`).innerHTML =
                    '<div class="placeholder">Waiting for query...</div>';
                document.getElementById(`status-${p}`).textContent = '';
            });
            input.value = '';
        }
        loadHistory();
    } catch {}
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---- Pane management ----

function resetPanes() {
    providers.forEach(p => {
        const pane = document.getElementById(`pane-${p}`);
        pane.classList.remove('focused', 'minimized');
        pane.style.flex = '';
        if (!paneVisible[p]) togglePane(p);
    });
    updateDividers();
}

function focusPane(target) {
    providers.forEach(p => {
        const pane = document.getElementById(`pane-${p}`);
        pane.style.flex = '';
        if (p === target) {
            pane.classList.add('focused');
            pane.classList.remove('minimized');
        } else {
            pane.classList.add('minimized');
            pane.classList.remove('focused');
        }
        // Show all panes when focusing
        if (!paneVisible[p]) togglePane(p);
    });
    updateDividers();
}

function togglePane(provider) {
    const pane = document.getElementById(`pane-${provider}`);
    const btn = document.getElementById(`toggle-${provider}`);
    paneVisible[provider] = !paneVisible[provider];

    if (paneVisible[provider]) {
        pane.classList.remove('hidden');
        pane.style.flex = '';
        btn.textContent = `Hide ${capitalize(provider)}`;
    } else {
        pane.classList.add('hidden');
        pane.classList.remove('focused', 'minimized');
        btn.textContent = `Show ${capitalize(provider)}`;
    }
    updateDividers();
}

function updateDividers() {
    const d1 = document.getElementById('divider-1');
    const d2 = document.getElementById('divider-2');

    d1.classList.toggle('hidden-divider',
        !paneVisible['claude'] || !paneVisible['chatgpt'] && !paneVisible['grok']);
    d2.classList.toggle('hidden-divider',
        !paneVisible['grok'] || !paneVisible['chatgpt'] && !paneVisible['claude']);

    if (!paneVisible['chatgpt'] && paneVisible['claude'] && paneVisible['grok']) {
        d1.classList.add('hidden-divider');
        d2.classList.remove('hidden-divider');
    }
}

function capitalize(s) {
    if (s === 'chatgpt') return 'ChatGPT';
    if (s === 'grok') return 'Grok';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- Drag-to-resize dividers ----

function initDividerDrag(dividerId, leftPaneId, rightPaneId) {
    const divider = document.getElementById(dividerId);
    const leftPane = document.getElementById(leftPaneId);
    const rightPane = document.getElementById(rightPaneId);
    const container = document.getElementById('panes-container');

    let isDragging = false;

    divider.addEventListener('mousedown', (e) => {
        if (divider.classList.contains('hidden-divider')) return;
        isDragging = true;
        divider.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const containerRect = container.getBoundingClientRect();
        const mouseX = e.clientX - containerRect.left;

        providers.forEach(p => {
            document.getElementById(`pane-${p}`).classList.remove('focused', 'minimized');
        });

        const leftRect = leftPane.getBoundingClientRect();
        const rightRect = rightPane.getBoundingClientRect();

        const leftStart = leftRect.left - containerRect.left;
        const rightEnd = rightRect.right - containerRect.left;

        const newLeftWidth = mouseX - leftStart - 2.5;
        const newRightWidth = rightEnd - mouseX - 2.5;

        const minWidth = 100;
        if (newLeftWidth >= minWidth && newRightWidth >= minWidth) {
            leftPane.style.flex = `0 0 ${newLeftWidth}px`;
            rightPane.style.flex = `0 0 ${newRightWidth}px`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            divider.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// Initialize placeholder content
providers.forEach(p => {
    document.getElementById(`content-${p}`).innerHTML =
        '<div class="placeholder">Waiting for query...</div>';
});

// Set up divider dragging
initDividerDrag('divider-1', 'pane-claude', 'pane-chatgpt');
initDividerDrag('divider-2', 'pane-chatgpt', 'pane-grok');
