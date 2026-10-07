'use strict';

// ---------- State & persistence ----------

const STORAGE_KEY = 'ollama-ui:v1';

const state = {
  chats: [],          // [{ id, title, model, messages: [{ role, content, thinking?, images?, imageFormat? }] }]
  currentId: null,
  models: [],         // [{ name, label?, capabilities: [], server? }] — image models have the 'image'
                      // capability (plus 'edit' for the edit server) and the URL prefix of their sd-server
  settings: {
    model: '', systemPrompt: '', temperature: 0.7, showThinking: true,
    imageSize: '1024x1024', upscaler: '4x-UltraMix_Balanced', freeVram: true,
  },
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
const isImageModel = name => hasCapability(name, 'image');
const isEditModel = name => hasCapability(name, 'edit');

// ---------- DOM ----------

const $ = id => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), chatList: $('chatList'), newChat: $('newChat'), menuBtn: $('menuBtn'),
  modelSelect: $('modelSelect'), messages: $('messages'), empty: $('empty'),
  composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'),
  fileInput: $('fileInput'), attachLabel: $('attachLabel'), attachments: $('attachments'),
  settingsBtn: $('settingsBtn'), settingsDialog: $('settingsDialog'),
  systemPrompt: $('systemPrompt'), temperature: $('temperature'), tempValue: $('tempValue'),
  showThinking: $('showThinking'), imageSize: $('imageSize'), customSize: $('customSize'),
  customWidth: $('customWidth'), customHeight: $('customHeight'), upscaler: $('upscaler'), freeVram: $('freeVram'),
  clearAll: $('clearAll'),
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
  if (msg.images?.length) {
    const generated = document.createElement('div');
    generated.className = 'generated-images';
    msg.images.forEach((b64, i) => {
      const src = `data:image/${msg.imageFormat || 'png'};base64,${b64}`;
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Generated image';
      generated.append(img);
      const download = document.createElement('button');
      download.type = 'button';
      download.textContent = msg.images.length > 1 ? `Download ${i + 1}` : 'Download';
      download.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = src;
        a.download = `image-${Date.now()}.${msg.imageFormat === 'jpeg' ? 'jpg' : msg.imageFormat || 'png'}`;
        a.click();
      });
      actions.append(download);
    });
    content.before(generated);
  } else {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyText(msg.content, copy));
    actions.append(copy);
  }
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
  await respond(chat);
}

async function regenerate() {
  const chat = currentChat();
  if (!chat || abortController) return;
  if (chat.messages.at(-1)?.role === 'assistant') chat.messages.pop();
  await respond(chat);
}

const respond = chat => (isImageModel(chat.model) ? generateImage(chat) : streamReply(chat));

async function streamReply(chat) {
  const model = chat.model;
  const reply = { role: 'assistant', content: '', thinking: '' };
  chat.messages.push(reply);
  renderMessages();
  const el = [...els.messages.querySelectorAll('.msg')].at(-1);
  el.querySelector('.msg-actions').style.display = 'none';

  const history = chat.messages.slice(0, -1).map(m => {
    if (m.role === 'assistant' && m.images?.length) {
      return { role: 'assistant', content: '[Generated an image for the previous message]' };
    }
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

// ---------- Image generation (stable-diffusion.cpp) ----------

async function generateImage(chat) {
  const userMsg = chat.messages.findLast(m => m.role === 'user');
  const server = modelInfo(chat.model)?.server || '/sdcpp';
  const editing = isEditModel(chat.model) && userMsg?.images?.length;
  const reply = { role: 'assistant', content: '', images: [] };
  chat.messages.push(reply);
  renderMessages();
  const el = [...els.messages.querySelectorAll('.msg')].at(-1);
  el.querySelector('.msg-actions').style.display = 'none';
  const content = el.querySelector('.content');
  content.innerHTML = '<div class="image-pending"><div class="spinner"></div><span></span></div>';
  const status = content.querySelector('span');

  abortController = new AbortController();
  const { signal } = abortController;
  setStreaming(true);
  const started = Date.now();
  let jobId = null;

  try {
    if (state.settings.freeVram) {
      status.textContent = 'Unloading chat models…';
      await unloadOllamaModels();
    }
    if (userMsg?.images?.length && !editing) {
      await upscaleImages(userMsg.images, reply, status, signal);
      return;
    }
    status.textContent = 'Starting…';
    const prompt = userMsg?.content || '';
    const [width, height] = editing
      ? await editSize(userMsg.images[0])
      : state.settings.imageSize.split('x').map(Number);
    const job = await fetchJson(`${server}/v1/img_gen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Steps, CFG and sampler come from the server's defaults for the loaded model.
      body: JSON.stringify({
        prompt, width, height, seed: -1, output_format: 'jpeg', output_compression: 92,
        ...(editing && { ref_images: userMsg.images }),
        // Decoding very large images in one pass can run out of VRAM.
        ...(width * height > 1536 * 1536 && { vae_tiling_params: { enabled: true } }),
      }),
      signal,
    });
    jobId = job.id;

    while (true) {
      const s = await fetchJson(`${server}/v1/jobs/${jobId}`, { signal });
      if (s.status === 'completed') {
        reply.images = s.result.images.map(img => img.b64_json);
        reply.imageFormat = s.result.output_format;
        break;
      }
      if (s.status === 'failed' || s.status === 'cancelled') {
        throw new Error(s.error?.message || `Image generation ${s.status}`);
      }
      const secs = Math.round((Date.now() - started) / 1000);
      status.textContent = s.status === 'queued'
        ? `Queued (position ${s.queue_position})…`
        : `${editing ? 'Editing' : 'Generating'} image… ${secs}s`;
      await sleep(1000, signal);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // The server can only cancel queued jobs; a running one finishes and is discarded.
      if (jobId) fetch(`${server}/v1/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
    } else {
      reply.error = err.message;
    }
  } finally {
    abortController = null;
    setStreaming(false);
    if (!reply.images.length) {
      delete reply.images;
      if (!reply.error) reply.content = '_(stopped)_';
    }
    save();
    renderMessages();
  }
}

// Attached images are upscaled with the server's ESRGAN model instead of
// being used as a prompt. The endpoint is synchronous, so there is no job to poll.
async function upscaleImages(images, reply, status, signal) {
  // ESRGAN only sees RGB, so transparency is carried over in the browser.
  const alphas = await Promise.all(images.map(extractAlpha));
  const png = alphas.some(Boolean);
  const notes = [];
  for (const [i, image] of images.entries()) {
    status.textContent = images.length > 1 ? `Upscaling image ${i + 1} of ${images.length}…` : 'Upscaling…';
    const r = await fetchJson('/sdcpp/v1/upscale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image, upscaler: state.settings.upscaler,
        output_format: png ? 'png' : 'jpeg', output_compression: png ? 100 : 95,
      }),
      signal,
    });
    const result = r.images[0].b64_json;
    reply.images.push(alphas[i] ? await applyAlpha(result, alphas[i], r.width, r.height) : result);
    notes.push(`${r.width} × ${r.height}`);
  }
  reply.imageFormat = png ? 'png' : 'jpeg';
  reply.content = `Upscaled to ${notes.join(', ')}`;
}

// Edits come out at the reference image's aspect ratio, at about one megapixel
// (what the model is trained for), in multiples of 16.
async function editSize(b64) {
  const img = await loadImage(`data:image/*;base64,${b64}`);
  const scale = Math.sqrt((1024 * 1024) / (img.naturalWidth * img.naturalHeight));
  const round16 = n => Math.max(256, Math.round((n * scale) / 16) * 16);
  return [round16(img.naturalWidth), round16(img.naturalHeight)];
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read image'));
    img.src = src;
  });
}

// Returns the image's alpha channel as a grayscale canvas, or null if it is fully opaque.
async function extractAlpha(b64) {
  const img = await loadImage(`data:image/*;base64,${b64}`);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  let transparent = false;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 255) transparent = true;
    px[i] = px[i + 1] = px[i + 2] = px[i + 3];
    px[i + 3] = 255;
  }
  if (!transparent) return null;
  ctx.putImageData(data, 0, 0);
  return canvas;
}

// Scales the alpha mask to the upscaled size and applies it, returning base64 PNG.
async function applyAlpha(b64, alpha, width, height) {
  const img = await loadImage(`data:image/png;base64,${b64}`);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const maskCtx = mask.getContext('2d');
  maskCtx.imageSmoothingQuality = 'high';
  maskCtx.drawImage(alpha, 0, 0, width, height);
  const out = ctx.getImageData(0, 0, width, height);
  const m = maskCtx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = m[i - 1];
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// Ollama keeps chat models in VRAM for a few minutes after use; evict them so
// the image model has the GPU to itself.
async function unloadOllamaModels() {
  try {
    const { models = [] } = await fetchJson('/api/ps');
    await Promise.all(models.map(m => fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m.name, keep_alive: 0 }),
    })));
  } catch (err) {
    console.warn('Could not unload Ollama models:', err);
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    // nginx answers 502/504 with an HTML page when the upstream is down or restarting.
    const message = data?.error?.message || data?.error
      || (res.status === 502 || res.status === 504
        ? `Server unreachable (HTTP ${res.status}) — it may have crashed or still be starting`
        : `HTTP ${res.status} ${res.statusText}`);
    throw new Error(message);
  }
  return data;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
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

async function loadChatModels() {
  try {
    const data = await fetchJson('/api/tags');
    return (data.models || [])
      .map(m => ({ name: m.name, capabilities: m.capabilities || [] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('Could not load Ollama models:', err);
    return [];
  }
}

// Each sd-server loads a single model at startup; offer it if it's up.
async function loadSdModel(server, capabilities, suffix) {
  try {
    const caps = await fetchJson(`${server}/v1/capabilities`);
    if (!caps.supported_modes?.includes('img_gen')) return [];
    const { stem } = caps.model;
    return [{ name: `image:${stem}`, label: `${stem}${suffix}`, capabilities, server }];
  } catch (err) {
    console.info(`Image server at ${server} unavailable:`, err.message);
    return [];
  }
}

async function loadImageModels() {
  const servers = await Promise.all([
    loadSdModel('/sdcpp', ['image'], ''),
    loadSdModel('/sdcpp-edit/sdcpp', ['image', 'edit'], ' (edit)'),
  ]);
  return servers.flat();
}

async function loadModels() {
  const [chatModels, imageModels] = await Promise.all([loadChatModels(), loadImageModels()]);
  state.models = [...chatModels, ...imageModels];

  els.modelSelect.innerHTML = '';
  if (!state.models.length) {
    const opt = new Option('Ollama unreachable / no models', '');
    els.modelSelect.append(opt);
    state.settings.model = '';
    return;
  }
  for (const [label, models] of [['Chat', chatModels], ['Image', imageModels]]) {
    if (!models.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const m of models) group.append(new Option(m.label || m.name, m.name));
    els.modelSelect.append(group);
  }
  if (!modelInfo(state.settings.model)) state.settings.model = state.models[0].name;
  els.modelSelect.value = state.settings.model;
  updateComposerForModel();
}

function updateComposerForModel() {
  // /api/tags only reports capabilities on newer Ollama; if absent, allow attaching.
  const info = modelInfo(state.settings.model);
  const canAttach = !info?.capabilities.length || info.capabilities.includes('vision')
    || isImageModel(state.settings.model);
  els.attachLabel.style.display = canAttach ? '' : 'none';
  if (!canAttach) clearAttachments();
  els.input.placeholder = isEditModel(state.settings.model)
    ? 'Describe an image to generate, or attach one and say how to change it'
    : isImageModel(state.settings.model)
      ? 'Describe an image to generate, or attach one to upscale'
      : 'Message Ollama';
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
  // Sizes not in the preset list are custom.
  const [width, height] = state.settings.imageSize.split('x');
  const preset = [...els.imageSize.options].some(o => o.value === state.settings.imageSize);
  els.imageSize.value = preset ? state.settings.imageSize : 'custom';
  els.customWidth.value = width;
  els.customHeight.value = height;
  els.customSize.hidden = preset;
  els.upscaler.value = state.settings.upscaler;
  els.freeVram.checked = state.settings.freeVram;
  els.settingsDialog.showModal();
}

els.imageSize.addEventListener('change', () => {
  els.customSize.hidden = els.imageSize.value !== 'custom';
});

// The server accepts 64–4096 px; dimensions must be multiples of 16.
function customDimension(input) {
  const n = Math.round(Number(input.value) / 16) * 16;
  return Math.min(4096, Math.max(64, n || 1024));
}

els.temperature.addEventListener('input', () => {
  els.tempValue.textContent = els.temperature.value;
});

els.settingsDialog.addEventListener('close', () => {
  state.settings.systemPrompt = els.systemPrompt.value;
  state.settings.temperature = Number(els.temperature.value);
  state.settings.showThinking = els.showThinking.checked;
  state.settings.imageSize = els.imageSize.value === 'custom'
    ? `${customDimension(els.customWidth)}x${customDimension(els.customHeight)}`
    : els.imageSize.value;
  state.settings.upscaler = els.upscaler.value;
  state.settings.freeVram = els.freeVram.checked;
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
  updateComposerForModel();
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
