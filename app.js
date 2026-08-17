/* SimpleTTS 前端逻辑 v2：edge-tts（晓晓）优先，浏览器语音兜底，自动恢复
 *
 * 主要改进：
 * - 运行时降级后每 8 秒自动探测服务，恢复后自动切回晓晓并同步短语
 * - edge 播放失败先重试一次（网络抖动），仍失败才降级
 * - 短语保存防抖（500ms）+ 串行队列，快速连续编辑只发一次
 * - 语速/音量/音色调整后防抖重新预热（800ms）
 * - 预热时页面隐藏自动让路
 */
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
  const RETRY_MS         = 8000;  // 服务重连周期
  const PUSH_DEBOUNCE_MS = 500;   // 短语保存防抖
  const REWARM_DEBOUNCE_MS = 800; // 参数调整后重新预热防抖

  let mode = "waiting";     // waiting | edge | local
  let audio = null;         // 当前 Audio 对象
  let currentEl = null;     // 正在朗读的短语元素
  let retryTimer = null;    // 服务恢复探测定时器
  let pushTimer = null;     // 短语保存防抖
  let adjustTimer = null;   // 参数调整重预热防抖
  let pushQueue = Promise.resolve(); // PUT 串行队列，防乱序覆盖

  // 常用短语：服务端持久化（多设备同步）+ 本地 localStorage 离线备份
  let phrases = [];
  let edited = false; // 服务端列表返回前本地是否已改动

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

  /* ---------- 服务健康检查与自动恢复 ---------- */

  function checkServer() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    return fetch("/api/ping", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => !!(d && d.ok))
      .catch(() => false)
      .finally(() => clearTimeout(timer));
  }

  // 连接可用：切回晓晓 + 与服务端对账短语 + 预热
  function onEdge() {
    setMode("edge", "晓晓语音 ✓");
    statusEl.removeAttribute("title");
    initPhrasesFromServer();
    warmPhrases(phrases);
  }

  // 进入本地模式时启动周期探测，服务恢复后自动切回晓晓
  function startRecovery() {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      checkServer().then((ok) => {
        if (ok) {
          clearInterval(retryTimer);
          retryTimer = null;
          onEdge();
        }
      });
    }, RETRY_MS);
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

  // edge 播放：失败先重试一次（抗网络抖动），仍失败则降级本地并启动恢复探测
  function playEdge(text, isRetry) {
    const a = new Audio(ttsUrl(text));
    a.volume = parseFloat(volumeEl.value);
    audio = a; // 先登记，stop() 会置 null，用于丢弃过期回调

    let fellBack = false;
    const degrade = () => {
      if (fellBack) return;
      fellBack = true;
      setMode("local", "已降级为本地语音");
      statusEl.title = "晓晓通道不可用，已切换本机语音；每 8 秒自动重试恢复";
      startRecovery();
      playLocal(text);
    };

    a.onerror = () => {
      if (fellBack || audio !== a) return; // 已被替换/停止，丢弃
      if (isRetry) { degrade(); return; }
      checkServer().then((ok) => {
        if (fellBack || audio !== a) return;
        if (ok) playEdge(text, true); // 服务正常，可能是瞬时故障，重试一次
        else degrade();
      });
    };
    a.onended = clearSpeaking;
    a.play().catch(() => a.onerror && a.onerror());
  }

  function speak(text) {
    text = (text || input.value).trim();
    if (!text) return;
    stop(); // 停掉上一句并清除旧高亮
    if (mode === "edge") playEdge(text, false);
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

  // 整表同步到服务端：500ms 防抖合并连续编辑，串行队列保证顺序
  function pushToServer(list) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushQueue = pushQueue.then(() =>
        fetch("/api/phrases", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phrases: list }),
        }).catch(() => { /* 离线时保留本地，下次编辑会自动再同步 */ })
      );
    }, PUSH_DEBOUNCE_MS);
  }

  function initPhrasesFromServer() {
    fetch("/api/phrases")
      .then((r) => r.json())
      .then((d) => {
        if (!d || !Array.isArray(d.phrases)) return;
        if (edited) {
          pushToServer(phrases); // 本地已改动：以本地为准并同步上去
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

  // 后台拉取常用语音频（浏览器按缓存头保存），之后点击同一短语秒出。
  // 页面隐藏时放慢节奏让路；最多 3 个并发。
  function warmPhrases(list) {
    if (mode !== "edge" || !list || !list.length) return;
    const urls = list.map(ttsUrl);
    let i = 0;
    const worker = () => {
      if (document.hidden) { setTimeout(worker, 1000); return; }
      if (i >= urls.length) return;
      const u = urls[i++];
      fetch(u).catch(() => {}).finally(() => setTimeout(worker, 150));
    };
    for (let c = 0; c < 3; c++) worker();
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
        // 仅在列表确实包含已选音色时才回填，避免无效选择
        if (saved && data.list.some((v) => v.id === saved)) voiceSel.value = saved;
      })
      .catch(() => { /* 服务不可用时保持默认音色 */ });
  }

  function initStatus() {
    const viaFile = location.protocol === "file:";
    checkServer().then((ok) => {
      if (ok) { onEdge(); return; }
      if (viaFile) {
        setMode("local", "本机语音模式");
        statusEl.title = "当前是直接打开 index.html 文件。要使用晓晓神经语音，请运行 start.bat 后访问 http://localhost:8000";
      } else {
        setMode("local", "本机语音（等待服务…）");
        statusEl.title = "未检测到本地语音服务，每 8 秒自动重试；也可运行 start.bat 启动";
      }
      startRecovery();
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

  // 语速/音量：拖动实时显示数值，松手（change）后防抖重新预热
  rateEl.addEventListener("input", () => {
    rateVal.value = parseFloat(rateEl.value).toFixed(2);
  });
  volumeEl.addEventListener("input", () => {
    volumeVal.value = Math.round(parseFloat(volumeEl.value) * 100) + "%";
  });
  rateEl.addEventListener("change", scheduleRewarm);
  volumeEl.addEventListener("change", scheduleRewarm);

  voiceSel.addEventListener("change", () => {
    localStorage.setItem(VOICE_KEY, voiceSel.value);
    scheduleRewarm();
  });

  function scheduleRewarm() {
    clearTimeout(adjustTimer);
    adjustTimer = setTimeout(() => {
      if (mode === "edge") warmPhrases(phrases);
    }, REWARM_DEBOUNCE_MS);
  }

  // 提前触发浏览器语音列表加载（部分浏览器首次 getVoices 为空）
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {};
    window.speechSynthesis.getVoices();
  }

  /* ---------- 启动 ---------- */

  phrases = loadLocalPhrases();
  renderPhrases();
  initVoices();
  initStatus(); // 内部会触发服务端短语同步与预热
})();
