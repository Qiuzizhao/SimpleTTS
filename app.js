/* SimpleTTS 前端逻辑：edge-tts（晓晓）优先，浏览器语音兜底 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const input        = $("input");
  const speakBtn     = $("speakBtn");
  const stopBtn      = $("stopBtn");
  const statusEl     = $("status");
  const phrasesEl    = $("phrases");
  const phraseInput  = $("phraseInput");
  const addPhraseBtn = $("addPhraseBtn");
  const resetPhrasesBtn = $("resetPhrasesBtn");
  const rateEl       = $("rate");
  const rateVal      = $("rateVal");
  const volumeEl     = $("volume");
  const volumeVal    = $("volumeVal");
  const voiceSel     = $("voiceSel");

  const PHRASES_KEY = "simplets.phrases";
  const VOICE_KEY   = "simplets.voice";

  let mode = "waiting";   // waiting | edge | local
  let audio = null;       // 当前 Audio 对象
  let currentEl = null;   // 正在朗读的短语元素
  let retryTimer = null;  // 本地模式下的自动重连定时器

  // 常用短语：服务端持久化（多设备同步）+ 本地 localStorage 离线备份
  let phrases = [];
  let edited = false;               // 服务端列表返回前本地是否已改动
  let pushQueue = Promise.resolve(); // PUT 串行排队，避免乱序覆盖

  /* ---------- 工具 ---------- */

  // 滑块值 → edge-tts 参数格式（如 +20% / -10%）
  function pct(ratio) {
    const n = Math.round(ratio * 100);
    return (n >= 0 ? "+" : "") + n + "%";
  }

  function loadJSON(k) {
    try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; }
  }

  function setMode(m, msg) {
    mode = m;
    statusEl.className = "status " +
      (m === "edge" ? "status-ok" : m === "local" ? "status-warn" : "status-waiting");
    statusEl.textContent = msg;
  }

  function clearSpeaking() {
    if (currentEl) {
      currentEl.classList.remove("speaking");
      currentEl = null;
    }
  }

  /* ---------- 语音通道 ---------- */

  function pickZhVoice() {
    const voices = window.speechSynthesis.getVoices();
    const zh = voices.filter((v) =>
      (v.lang || "").toLowerCase().replace("_", "-").startsWith("zh"));
    if (!zh.length) return null;
    const preferred = ["Xiaoxiao", "Huihui", "Yaoyao", "Kangkang", "Xiaoqiu", "Tingting"];
    for (const name of preferred) {
      const hit = zh.find((v) => v.name.includes(name));
      if (hit) return hit;
    }
    return zh[0];
  }

  function playLocal(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = parseFloat(rateEl.value);
    u.volume = parseFloat(volumeEl.value);
    const v = pickZhVoice();
    if (v) u.voice = v;
    u.onend = clearSpeaking;
    window.speechSynthesis.speak(u);
  }

  // 生成 /api/tts 的 URL（文本+音色+语速+音量 → 同一 URL 永远同一段音频，可被浏览器缓存）
  function ttsUrl(text) {
    const voice = localStorage.getItem(VOICE_KEY) || "zh-CN-XiaoxiaoNeural";
    return "/api/tts?text=" + encodeURIComponent(text) +
      "&voice=" + encodeURIComponent(voice) +
      "&rate=" + encodeURIComponent(pct(parseFloat(rateEl.value) - 1)) +
      "&volume=" + encodeURIComponent(pct(parseFloat(volumeEl.value) - 1));
  }

  function playEdge(text) {
    const a = new Audio(ttsUrl(text));
    a.volume = parseFloat(volumeEl.value);
    let fellBack = false;
    const fallback = () => {
      if (fellBack) return;
      fellBack = true;
      setMode("local", "已降级为本地语音");
      playLocal(text);
    };
    a.onerror = fallback;
    a.onended = clearSpeaking;
    a.play().catch(fallback);
    audio = a;
  }

  function speak(text) {
    text = (text || input.value).trim();
    if (!text) return;
    stop(); // 停掉上一句并清除旧高亮
    if (mode === "edge") playEdge(text);
    else playLocal(text);
  }

  function stop() {
    if (audio) { audio.pause(); audio = null; }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    clearSpeaking();
  }

  /* ---------- 常用短语（服务端持久化 + 本地备份） ---------- */

  // 启动时先从本机读（离线也能用），随后用服务端列表覆盖（多设备同步）
  function loadLocalPhrases() {
    const saved = loadJSON(PHRASES_KEY);
    if (Array.isArray(saved) && saved.length) return saved;
    let list = [...DEFAULT_PHRASES];
    // 迁移旧版"我的短语"
    const legacy = loadJSON("simplets.customPhrases");
    if (Array.isArray(legacy)) {
      for (const p of legacy) if (!list.includes(p)) list.push(p);
    }
    return list;
  }

  function persistLocal(list) {
    localStorage.setItem(PHRASES_KEY, JSON.stringify(list));
  }

  // 整表同步到服务端；串行排队，避免快速连续编辑时乱序覆盖
  function pushToServer(list) {
    pushQueue = pushQueue.then(() =>
      fetch("/api/phrases", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrases: list }),
      }).catch(() => { /* 离线时保留本地，下次编辑会自动再同步 */ })
    );
  }

  function initPhrasesFromServer() {
    fetch("/api/phrases")
      .then((r) => r.json())
      .then((d) => {
        if (!d || !Array.isArray(d.phrases)) return;
        if (edited) {
          pushToServer(phrases); // 服务端列表返回前本地已改动：以本地为准并同步上去
          return;
        }
        if (d.phrases.length) {
          phrases = d.phrases;
          persistLocal(phrases); // 留本地备份
          renderPhrases();
          warmPhrases(phrases);
        } else {
          pushToServer(phrases); // 服务端为空：把当前列表迁移上去
        }
      })
      .catch(() => { /* 服务不可用：继续用本地列表 */ });
  }

  function makePhraseChip(p) {
    const wrap = document.createElement("span");
    wrap.className = "phrase-chip";

    const t = document.createElement("button");
    t.type = "button";
    t.className = "phrase-btn";
    t.textContent = p;
    t.addEventListener("click", () => {
      speak(p);
      currentEl = wrap;
      wrap.classList.add("speaking");
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.title = "删除此短语";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removePhrase(p);
    });

    wrap.appendChild(t);
    wrap.appendChild(del);
    return wrap;
  }

  function renderPhrases() {
    phrasesEl.innerHTML = "";
    phrases.forEach((p) => phrasesEl.appendChild(makePhraseChip(p)));
  }

  function addPhrase() {
    const v = phraseInput.value.trim();
    if (!v) return;
    if (!phrases.includes(v)) {
      phrases.push(v);
      edited = true;
      persistLocal(phrases);
      pushToServer(phrases);
      renderPhrases();
      warmPhrases([v]); // 新短语立即预热，第一次点也快
    }
    phraseInput.value = "";
  }

  function removePhrase(p) {
    stop();
    phrases = phrases.filter((x) => x !== p);
    edited = true;
    persistLocal(phrases);
    pushToServer(phrases);
    renderPhrases();
  }

  function resetPhrases() {
    if (!confirm("确定恢复默认短语吗？当前列表将被替换。")) return;
    stop();
    phrases = [...DEFAULT_PHRASES];
    edited = true;
    persistLocal(phrases);
    pushToServer(phrases);
    renderPhrases();
    warmPhrases(phrases);
  }

  /* ---------- 常用语语音预热 ---------- */

  // 打开页面后后台拉取常用语音频（浏览器会按缓存头保存），
  // 之后点击同一短语走浏览器/服务端缓存，秒出。
  function warmPhrases(list) {
    if (mode !== "edge" || !list || !list.length) return;
    const urls = list.map(ttsUrl);
    let i = 0;
    const worker = () => {
      if (i >= urls.length) return;
      const u = urls[i++];
      fetch(u).catch(() => {}).finally(() => setTimeout(worker, 150));
    };
    for (let c = 0; c < 3; c++) worker(); // 最多 3 个并发，避免瞬间打满
  }

  /* ---------- 初始化 ---------- */

  function initVoices() {
    voiceSel.innerHTML =
      '<option value="zh-CN-XiaoxiaoNeural">晓晓（女声 · 推荐）</option>';
    const saved = localStorage.getItem(VOICE_KEY);
    if (saved) voiceSel.value = saved;
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data) => {
        if (!data || !Array.isArray(data.list)) return;
        voiceSel.innerHTML = data.list
          .map((v) => `<option value="${v.id}">${v.name}</option>`)
          .join("");
        if (saved) voiceSel.value = saved;
      })
      .catch(() => { /* 服务不可用时保持默认音色 */ });
  }

  function checkServer() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    return fetch("/api/ping", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => !!(d && d.ok))
      .catch(() => false)
      .finally(() => clearTimeout(timer));
  }

  function initStatus() {
    const viaFile = location.protocol === "file:";
    const onOk = () => {
      setMode("edge", "晓晓语音 ✓");
      warmPhrases(phrases); // 连接稳定后后台预热常用语
    };
    const onFail = () => {
      if (viaFile) {
        setMode("local", "本机语音模式");
        statusEl.title = "当前是直接打开 index.html 文件。要使用晓晓神经语音，请运行 start.bat 后访问 http://localhost:8000";
      } else {
        setMode("local", "本机语音（等待服务…）");
        statusEl.title = "未检测到本地语音服务，每 8 秒自动重试；也可运行 start.bat 启动";
      }
    };

    checkServer().then((ok) => {
      if (ok) { onOk(); return; }
      onFail();
      retryTimer = setInterval(() => {
        checkServer().then((ok2) => {
          if (ok2) {
            clearInterval(retryTimer);
            retryTimer = null;
            onOk();
          }
        });
      }, 8000);
    });
  }

  /* ---------- 事件 ---------- */

  speakBtn.addEventListener("click", () => speak(input.value));
  stopBtn.addEventListener("click", stop);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      speak(input.value);
    }
  });

  addPhraseBtn.addEventListener("click", addPhrase);
  phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addPhrase(); }
  });
  resetPhrasesBtn.addEventListener("click", resetPhrases);

  rateEl.addEventListener("input", () => {
    rateVal.value = parseFloat(rateEl.value).toFixed(2);
  });
  volumeEl.addEventListener("input", () => {
    volumeVal.value = Math.round(parseFloat(volumeEl.value) * 100) + "%";
  });
  voiceSel.addEventListener("change", () => {
    localStorage.setItem(VOICE_KEY, voiceSel.value);
  });

  // 部分浏览器语音列表异步加载，提前触发一次
  if ("speechSynthesis" in window && window.speechSynthesis.onvoiceschanged) {
    window.speechSynthesis.onvoiceschanged = () => {};
  }

  phrases = loadLocalPhrases();
  renderPhrases();
  initVoices();
  initStatus();
  initPhrasesFromServer();
})();
