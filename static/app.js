// State
const providers = ['claude', 'chatgpt', 'grok'];
const paneVisible = { claude: true, chatgpt: true, grok: true };
// Per-provider conversation messages: array of {role, content}
const conversation = { claude: [], chatgpt: [], grok: [] };
// Track which providers are currently streaming
const streaming = { claude: false, chatgpt: false, grok: false };
let currentConversationId = null;
let historyOpen = false;

// Elements
const input = document.getElementById('query-input');
const sendBtn = document.getElementById('send-btn');

// Enter to submit on main input
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitQuery();
    }
});

// Enter to submit on follow-up inputs
providers.forEach(p => {
    document.getElementById(`followup-${p}`).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendFollowup(p);
        }
    });
});

// ---- New conversation (send to all) ----

sendBtn.addEventListener('click', () => submitQuery());

async function submitQuery() {
    const query = input.value.trim();
    if (!query || providers.some(p => streaming[p])) return;

    // Create conversation on server
    try {
        const res = await fetch('/api/conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await res.json();
        currentConversationId = data.conversation_id;
    } catch {
        currentConversationId = null;
    }

    // Reset conversation state and UI for all providers
    providers.forEach(p => {
        conversation[p] = [{ role: 'user', content: query }];
        document.getElementById(`tokens-${p}`).textContent = '';
    });

    // Stream all three
    providers.forEach(p => streamProvider(p));
    loadHistory();
}

// ---- Follow-up (single provider or multiple) ----

async function sendFollowup(provider) {
    const inputEl = document.getElementById(`followup-${provider}`);
    const query = inputEl.value.trim();
    if (!query || streaming[provider] || !currentConversationId) return;
    inputEl.value = '';

    // Add user message to this provider's conversation
    conversation[provider].push({ role: 'user', content: query });

    // Save follow-up to DB
    try {
        await fetch(`/api/conversation/${currentConversationId}/followup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, providers: [provider] }),
        });
    } catch {}

    // Re-render to show the user message, then stream
    renderConversation(provider);
    document.getElementById(`tokens-${provider}`).textContent = '';
    streamProvider(provider);
}

// ---- Streaming ----

function streamProvider(provider) {
    const statusEl = document.getElementById(`status-${provider}`);
    const followupBtn = document.querySelector(`#pane-${provider} .followup-btn`);

    streaming[provider] = true;
    statusEl.textContent = 'streaming...';
    followupBtn.disabled = true;
    updateSendBtn();
    renderConversation(provider);

    const apiMessages = conversation[provider].map(m => ({
        role: m.role,
        content: m.content,
    }));

    let assistantText = '';
    let processed = 0;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/stream/${provider}`);
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.onprogress = function () {
        const newData = xhr.responseText.substring(processed);
        processed = xhr.responseText.length;
        const lines = newData.split('\n');
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
                const data = JSON.parse(payload);
                if (data.text) {
                    assistantText += data.text;
                    renderConversation(provider, assistantText);
                }
                if (data.usage) {
                    displayTokens(provider, data.usage);
                }
            } catch {}
        }
    };

    xhr.onload = function () {
        // Process any remaining data not caught by onprogress
        if (processed < xhr.responseText.length) {
            xhr.onprogress();
        }
        if (xhr.status >= 400) {
            statusEl.textContent = 'error';
            try {
                const errData = JSON.parse(xhr.responseText);
                assistantText += `\n\n[Error: ${errData.error || 'HTTP ' + xhr.status}]`;
            } catch {
                assistantText += `\n\n[Error: HTTP ${xhr.status}]`;
            }
        } else {
            statusEl.textContent = 'done';
        }
        finishStream();
    };

    xhr.onerror = function () {
        statusEl.textContent = 'error';
        assistantText += '\n\n[Connection error]';
        finishStream();
    };

    function finishStream() {
        conversation[provider].push({ role: 'assistant', content: assistantText });
        streaming[provider] = false;
        followupBtn.disabled = false;
        updateSendBtn();
        renderConversation(provider);
    }

    xhr.send(JSON.stringify({
        conversation_id: currentConversationId,
        messages: apiMessages,
    }));
}

function updateSendBtn() {
    sendBtn.disabled = providers.some(p => streaming[p]);
}

// ---- Rendering ----

function renderConversation(provider, pendingAssistant) {
    const contentEl = document.getElementById(`content-${provider}`);
    const isAtBottom = contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight < 40;

    let html = '';
    for (const msg of conversation[provider]) {
        if (msg.role === 'user') {
            html += `<div class="msg msg-user"><div class="msg-label">You</div><div class="msg-body">${marked.parse(msg.content)}</div></div>`;
        } else {
            html += `<div class="msg msg-assistant"><div class="msg-body">${marked.parse(msg.content)}</div></div>`;
        }
    }

    // Pending assistant response (still streaming)
    if (pendingAssistant !== undefined) {
        html += `<div class="msg msg-assistant streaming-cursor"><div class="msg-body">${marked.parse(pendingAssistant)}</div></div>`;
    }

    contentEl.innerHTML = html;

    if (isAtBottom) {
        contentEl.scrollTop = contentEl.scrollHeight;
    }
}

// ---- Token display ----

function displayTokens(provider, usage) {
    const el = document.getElementById(`tokens-${provider}`);
    if (usage && usage.input_tokens != null) {
        const total = usage.input_tokens + usage.output_tokens;
        el.textContent = `${usage.input_tokens} in / ${usage.output_tokens} out (${total} total)`;
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
            listEl.innerHTML = '<div class="history-empty">No conversations yet</div>';
            return;
        }
        listEl.innerHTML = items.map(item => {
            const date = new Date(item.created_at);
            const dateStr = date.toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const isActive = item.id === currentConversationId ? ' active' : '';
            return `
                <div class="history-item${isActive}" data-id="${item.id}" onclick="loadHistoryEntry(${item.id})">
                    <div class="history-item-content">
                        <div class="history-item-query">${escapeHtml(item.title)}</div>
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
    if (providers.some(p => streaming[p])) return;

    try {
        const res = await fetch(`/api/history/${id}`);
        const data = await res.json();
        currentConversationId = data.id;
        input.value = '';

        providers.forEach(p => {
            const msgs = data.messages[p] || [];
            conversation[p] = msgs.map(m => ({ role: m.role, content: m.content }));
            renderConversation(p);

            const statusEl = document.getElementById(`status-${p}`);
            const tokensEl = document.getElementById(`tokens-${p}`);

            if (msgs.length > 0) {
                statusEl.textContent = 'done';
                // Show tokens from the last assistant message
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
                if (lastAssistant && lastAssistant.input_tokens != null) {
                    displayTokens(p, {
                        input_tokens: lastAssistant.input_tokens,
                        output_tokens: lastAssistant.output_tokens,
                    });
                } else {
                    tokensEl.textContent = '';
                }
            } else {
                statusEl.textContent = '';
                tokensEl.textContent = '';
            }
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
        if (currentConversationId === id) {
            currentConversationId = null;
            providers.forEach(p => {
                conversation[p] = [];
                document.getElementById(`content-${p}`).innerHTML =
                    '<div class="placeholder">Waiting for query...</div>';
                document.getElementById(`status-${p}`).textContent = '';
                document.getElementById(`tokens-${p}`).textContent = '';
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
