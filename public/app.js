'use strict';

// ---------- State & persistence ----------

const STORAGE_KEY = 'ollama-ui:v1';

const state = {
  chats: [],          // [{ id, title, model, messages: [{ role, content, thinking?, images? }] }]
  currentId: null,
  models: [],         // [{ name, capabilities: [] }]
  settings: { model: '', systemPrompt: '', temperature: 0.7, showThinking: true },
};

let pendingImages = [];   // base64 strings (no data: prefix) for the next message
let abortController = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      state.chats = saved.chats || [];
      state.currentId = saved.currentId || null;
      Object.assign(state.settings, saved.settings || {});
    }
  } catch { /* storage unavailable or corrupt — start fresh */ }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      chats: state.chats, currentId: state.currentId, settings: state.settings,
    }));
  } catch (err) {
    console.warn('Could not save chats (storage may be full):', err);
  }
}

const currentChat = () => state.chats.find(c => c.id === state.currentId) || null;
const modelInfo = name => state.models.find(m => m.name === name);
const hasCapability = (name, cap) => (modelInfo(name)?.capabilities || []).includes(cap);

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), chatList: $('chatList'), newChat: $('newChat'), menuBtn: $('menuBtn'),
  modelSelect: $('modelSelect'), messages: $('messages'), empty: $('empty'),
  composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'),
  fileInput: $('fileInput'), attachLabel: $('attachLabel'), attachments: $('attachments'),
  settingsBtn: $('settingsBtn'), settingsDialog: $('settingsDialog'),
  systemPrompt: $('systemPrompt'), temperature: $('temperature'), tempValue: $('tempValue'),
  showThinking: $('showThinking'), clearAll: $('clearAll'),
};

// ---------- Markdown rendering ----------

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text) {
  const container = document.createElement('div');
  container.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));

  container.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    const lang = (code.className.match(/language-(\S+)/) || [])[1] || '';
    if (lang && hljs.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value;
    } else {
      hljs.highlightElement(code);
    }
    code.classList.add('hljs');

    const block = document.createElement('div');
    block.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const label = document.createElement('span');
    label.textContent = lang || 'code';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.dataset.copy = '';
    header.append(label, copy);
    pre.replaceWith(block);
    block.append(header, pre);
  });

  return container.innerHTML;
}

// Copy buttons are re-created on every render, so handle them by delegation.
els.messages.addEventListener('click', e => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = btn.closest('.code-block').querySelector('code').textContent;
  copyText(text, btn);
});

function copyText(text, btn) {
  const done = () => {
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done);
  } else {
    // Clipboard API needs HTTPS or localhost; fall back for LAN access over plain HTTP.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  }
}

// ---------- Sidebar ----------

function renderChatList() {
  els.chatList.innerHTML = '';
  for (const chat of state.chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.currentId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = chat.title || 'New chat';
    const del = document.createElement('button');
    del.className = 'delete';
    del.title = 'Delete chat';
    del.textContent = '✕';
    del.addEventListener('click', e => {
      e.stopPropagation();
      deleteChat(chat.id);
    });
    item.append(title, del);
    item.addEventListener('click', () => selectChat(chat.id));
    els.chatList.append(item);
  }
}

function newChat() {
  stopStreaming();
  state.currentId = null;
  save();
  renderAll();
  els.input.focus();
}

function selectChat(id) {
  stopStreaming();
  state.currentId = id;
  const chat = currentChat();
  if (chat?.model && modelInfo(chat.model)) {
    state.settings.model = chat.model;
    els.modelSelect.value = chat.model;
  }
  save();
  renderAll();
  if (window.innerWidth <= 768) els.sidebar.classList.add('collapsed');
}

function deleteChat(id) {
  if (id === state.currentId) stopStreaming();
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.currentId === id) state.currentId = null;
  save();
  renderAll();
}

// ---------- Messages ----------

function renderMessages() {
  const chat = currentChat();
  els.messages.querySelectorAll('.msg').forEach(n => n.remove());
  els.empty.style.display = chat?.messages.length ? 'none' : '';
  if (!chat) return;
  chat.messages.forEach((msg, i) => {
    els.messages.append(buildMessage(msg, i === chat.messages.length - 1));
  });
  scrollToBottom(true);
}

function buildMessage(msg, isLast) {
  const el = document.createElement('div');
  el.className = `msg ${msg.role}`;

  if (msg.role === 'user') {
    if (msg.images?.length) {
      const imgs = document.createElement('div');
      imgs.className = 'images';
      for (const b64 of msg.images) {
        const img = document.createElement('img');
        img.src = `data:image/*;base64,${b64}`;
        imgs.append(img);
      }
      el.append(imgs);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.content;
    el.append(bubble);
    return el;
  }

  const thinking = document.createElement('details');
  thinking.className = 'thinking';
  thinking.innerHTML = '<summary>Thinking</summary><div class="thinking-body"></div>';
  const content = document.createElement('div');
  content.className = 'content';
  el.append(thinking, content);
  updateAssistantMessage(el, msg);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(msg.content, copy));
  actions.append(copy);
  if (isLast) {
    const regen = document.createElement('button');
    regen.type = 'button';
    regen.textContent = 'Regenerate';
    regen.addEventListener('click', regenerate);
    actions.append(regen);
  }
  el.append(actions);
  return el;
}

function updateAssistantMessage(el, msg, streaming = false) {
  const thinking = el.querySelector('.thinking');
  const showThinking = state.settings.showThinking && msg.thinking;
  thinking.style.display = showThinking ? '' : 'none';
  if (showThinking) {
    thinking.querySelector('.thinking-body').textContent = msg.thinking;
    thinking.querySelector('summary').textContent =
      streaming && !msg.content ? 'Thinking…' : 'Thought process';
  }

  const content = el.querySelector('.content');
  if (msg.error) {
    content.innerHTML = '';
    const err = document.createElement('p');
    err.className = 'error';
    err.textContent = `Error: ${msg.error}`;
    content.append(err);
  } else {
    content.innerHTML = renderMarkdown(msg.content);
  }
  content.classList.toggle('cursor', streaming);
}

function isNearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
}

// ---------- Chat with Ollama ----------

async function sendMessage(text) {
  const model = state.settings.model;
  if (!model) {
    alert('No model selected. Pull one with `ollama pull <model>` first.');
    return;
  }

  let chat = currentChat();
  if (!chat) {
    chat = { id: crypto.randomUUID?.() || String(Date.now()), title: '', model, messages: [] };
    state.chats.unshift(chat);
    state.currentId = chat.id;
  }
  chat.model = model;
  if (!chat.title) chat.title = text.slice(0, 50) || 'Image';

  const userMsg = { role: 'user', content: text };
  if (pendingImages.length) userMsg.images = pendingImages;
  chat.messages.push(userMsg);
  clearAttachments();

  // Move the active chat to the top of the list.
  state.chats = [chat, ...state.chats.filter(c => c !== chat)];
  save();
  renderChatList();
  await streamReply(chat);
}

async function regenerate() {
  const chat = currentChat();
  if (!chat || abortController) return;
  if (chat.messages.at(-1)?.role === 'assistant') chat.messages.pop();
  await streamReply(chat);
}

async function streamReply(chat) {
  const model = chat.model;
  const reply = { role: 'assistant', content: '', thinking: '' };
  chat.messages.push(reply);
  renderMessages();
  const el = [...els.messages.querySelectorAll('.msg')].at(-1);
  el.querySelector('.msg-actions').style.display = 'none';

  const history = chat.messages.slice(0, -1).map(m => {
    const out = { role: m.role, content: m.content };
    if (m.images) out.images = m.images;
    return out;
  });
  if (state.settings.systemPrompt.trim()) {
    history.unshift({ role: 'system', content: state.settings.systemPrompt.trim() });
  }

  const body = {
    model,
    messages: history,
    stream: true,
    options: { temperature: Number(state.settings.temperature) },
  };
  // Sending `think` to a model without thinking support is an error in Ollama.
  if (hasCapability(model, 'thinking')) body.think = !!state.settings.showThinking;

  abortController = new AbortController();
  setStreaming(true);

  let renderQueued = false;
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const stick = isNearBottom();
      updateAssistantMessage(el, reply, true);
      if (stick) scrollToBottom(true);
    });
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    if (!res.ok) {
      const detail = await res.text();
      let message = detail;
      try { message = JSON.parse(detail).error || detail; } catch { /* not JSON */ }
      throw new Error(message || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.message?.thinking) reply.thinking += chunk.message.thinking;
        if (chunk.message?.content) reply.content += chunk.message.content;
        queueRender();
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') reply.error = err.message;
  } finally {
    abortController = null;
    setStreaming(false);
    if (!reply.content && !reply.error && !reply.thinking) {
      reply.content = '_(stopped)_';
    }
    save();
    renderMessages();
  }
}

function stopStreaming() {
  abortController?.abort();
}

function setStreaming(on) {
  els.sendBtn.classList.toggle('streaming', on);
  els.sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  updateSendButton();
}

function updateSendButton() {
  const hasInput = els.input.value.trim() || pendingImages.length;
  els.sendBtn.disabled = !abortController && !hasInput;
}

// ---------- Models ----------

async function loadModels() {
  try {
    const res = await fetch('/api/tags');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.models = (data.models || [])
      .map(m => ({ name: m.name, capabilities: m.capabilities || [] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    state.models = [];
    console.error('Could not load models:', err);
  }

  els.modelSelect.innerHTML = '';
  if (!state.models.length) {
    const opt = new Option('Ollama unreachable / no models', '');
    els.modelSelect.append(opt);
    state.settings.model = '';
    return;
  }
  for (const m of state.models) els.modelSelect.append(new Option(m.name, m.name));
  if (!modelInfo(state.settings.model)) state.settings.model = state.models[0].name;
  els.modelSelect.value = state.settings.model;
  updateAttachVisibility();
}

function updateAttachVisibility() {
  // /api/tags only reports capabilities on newer Ollama; if absent, allow attaching.
  const info = modelInfo(state.settings.model);
  const vision = !info?.capabilities.length || info.capabilities.includes('vision');
  els.attachLabel.style.display = vision ? '' : 'none';
  if (!vision) clearAttachments();
}

// ---------- Attachments ----------

function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      pendingImages.push(reader.result.split(',')[1]);
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

function renderAttachments() {
  els.attachments.innerHTML = '';
  pendingImages.forEach((b64, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'attachment';
    const img = document.createElement('img');
    img.src = `data:image/*;base64,${b64}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    wrap.append(img, remove);
    els.attachments.append(wrap);
  });
  updateSendButton();
}

function clearAttachments() {
  pendingImages = [];
  renderAttachments();
}

// ---------- Settings ----------

function openSettings() {
  els.systemPrompt.value = state.settings.systemPrompt;
  els.temperature.value = state.settings.temperature;
  els.tempValue.textContent = state.settings.temperature;
  els.showThinking.checked = state.settings.showThinking;
  els.settingsDialog.showModal();
}

els.temperature.addEventListener('input', () => {
  els.tempValue.textContent = els.temperature.value;
});

els.settingsDialog.addEventListener('close', () => {
  state.settings.systemPrompt = els.systemPrompt.value;
  state.settings.temperature = Number(els.temperature.value);
  state.settings.showThinking = els.showThinking.checked;
  save();
  renderMessages();
});

els.clearAll.addEventListener('click', () => {
  if (!confirm('Delete all chats? This cannot be undone.')) return;
  stopStreaming();
  state.chats = [];
  state.currentId = null;
  save();
  renderAll();
  els.settingsDialog.close();
});

// ---------- Wiring ----------

function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
}

els.composer.addEventListener('submit', e => {
  e.preventDefault();
  if (abortController) {
    stopStreaming();
    return;
  }
  const text = els.input.value.trim();
  if (!text && !pendingImages.length) return;
  els.input.value = '';
  autoResize();
  sendMessage(text);
});

els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!abortController) els.composer.requestSubmit();
  }
});

els.input.addEventListener('input', () => {
  autoResize();
  updateSendButton();
});

els.input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length && els.attachLabel.style.display !== 'none') {
    e.preventDefault();
    addImages(files);
  }
});

els.fileInput.addEventListener('change', () => {
  addImages(els.fileInput.files);
  els.fileInput.value = '';
});

els.modelSelect.addEventListener('change', () => {
  state.settings.model = els.modelSelect.value;
  save();
  updateAttachVisibility();
});

els.newChat.addEventListener('click', newChat);
els.menuBtn.addEventListener('click', () => els.sidebar.classList.toggle('collapsed'));
els.settingsBtn.addEventListener('click', openSettings);

function renderAll() {
  renderChatList();
  renderMessages();
  updateSendButton();
}

load();
if (window.innerWidth <= 768) els.sidebar.classList.add('collapsed');
renderAll();
loadModels();
els.input.focus();
