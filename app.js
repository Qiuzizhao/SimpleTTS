/* SimpleTTS 前端逻辑 v3：edge-tts（默认晓伊）优先，浏览器语音兜底，自动恢复
 *
 * v3 交互：
 * - 主按钮"朗读 ⇄ 停止"一键切换，播放中显示正在朗读的内容条
 * - 输入框一键清空、Esc 停止、添加短语后自动聚焦
 * - 空短语列表提示
 * v2 能力保留：自动恢复网络语音、播放失败重试、防抖保存与预热、参数变更重预热
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const input        = $("input");
  const clearBtn     = $("clearBtn");
  const speakBtn     = $("speakBtn");
  const statusEl     = $("status");
  const nowPlaying   = $("nowPlaying");
  const nowPlayingText = $("nowPlayingText");
  const phrasesEl    = $("phrases");
  const phrasesEmpty = $("phrasesEmpty");
  const phraseInput  = $("phraseInput");
  const addPhraseBtn = $("addPhraseBtn");
  const editBtn     = $("editBtn");
  const phrasesHint = $("phrasesHint");
  const undoToast   = $("undoToast");
  const undoText    = $("undoText");
  const undoBtn     = $("undoBtn");
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

  // 音色 ID → 显示名（状态角标用）；"local" 表示本机合成
  const VOICE_NAMES = {
    "zh-CN-XiaoyiNeural": "晓伊",
    "zh-CN-XiaoxiaoNeural": "晓晓",
    "zh-CN-YunxiNeural": "云希",
    "zh-CN-YunjianNeural": "云健",
    "zh-CN-YunyangNeural": "云扬",
    "zh-CN-YunxiaNeural": "云夏",
    "local": "本地",
  };

  const LOCAL_OPTION = '<option value="local">本地语音（本机合成）</option>';

  function currentVoiceId() {
    return localStorage.getItem(VOICE_KEY) || "zh-CN-XiaoyiNeural";
  }

  function currentVoiceName() {
    const v = currentVoiceId();
    return VOICE_NAMES[v] || v;
  }

  let mode = "waiting";     // waiting | edge | local
  let isSpeaking = false;   // 是否正在朗读
  let audio = null;         // 当前 Audio 对象
  let currentEl = null;     // 正在朗读的短语元素
  let retryTimer = null;    // 服务恢复探测定时器
  let pushTimer = null;     // 短语保存防抖
  let adjustTimer = null;   // 参数调整重预热防抖
  let pushQueue = Promise.resolve(); // PUT 串行队列，防乱序覆盖

  // 常用短语：服务端持久化（多设备同步）+ 本地 localStorage 离线备份
  let phrases = [];
  let edited = false; // 服务端列表返回前本地是否已改动
  let editMode = false;   // 短语编辑模式（默认隐藏删除按钮，防误触）
  let lastDeleted = null; // 最近删除的短语 {text, index}，用于撤销
  let undoTimer = null;   // 撤销提示自动消失定时器

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

  // 朗读状态同步：主按钮切换 + 正在朗读提示条
  function setSpeaking(on, text) {
    isSpeaking = on;
    speakBtn.classList.toggle("speaking", on);
    speakBtn.textContent = on ? "⏹ 停止" : "🔊 朗读";
    if (on) {
      nowPlayingText.textContent = text;
      nowPlaying.hidden = false;
    } else {
      nowPlaying.hidden = true;
    }
    if (!on) clearSpeaking();
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

  // 连接可用：切回网络语音通道（音色按用户选择）+ 与服务端对账短语 + 预热
  function onEdge() {
    if (currentVoiceId() === "local") {
      setMode("local", "本地语音"); // 用户已显式选择本地，不自动切回网络
      return;
    }
    setMode("edge", currentVoiceName() + "语音 ✓");
    statusEl.removeAttribute("title");
    initPhrasesFromServer();
    warmPhrases(phrases);
  }

  // 进入本地模式时启动周期探测，服务恢复后自动切回网络语音
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
    u.onend = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }

  // 生成 /api/tts 的 URL（文本+音色+语速+音量 → 同一 URL 永远同一段音频，可被浏览器缓存）
  function ttsUrl(text) {
    const saved = localStorage.getItem(VOICE_KEY);
    const voice = saved && saved !== "local" ? saved : "zh-CN-XiaoyiNeural";
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
      statusEl.title = "网络语音通道不可用，已切换本机语音；每 8 秒自动重试恢复";
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
    a.onended = () => setSpeaking(false);
    a.play().catch(() => a.onerror && a.onerror());
  }

  function speak(text) {
    text = (text || input.value).trim();
    if (!text) return;
    stop(); // 停掉上一句并清除旧状态
    setSpeaking(true, text); // 乐观显示"正在朗读"
    if (currentVoiceId() === "local") { playLocal(text); return; } // 用户明确选择本地合成
    if (mode === "edge") playEdge(text, false);
    else playLocal(text);
  }

  function stop() {
    if (audio) { audio.pause(); audio = null; }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
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
      if (editMode) return; // 编辑模式下不朗读，专注管理，防误触
      speak(p);
      currentEl = wrap;
      wrap.classList.add("speaking");
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.title = "删除此短语";
    del.setAttribute("aria-label", "删除短语：" + p);
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
    phrasesEl.classList.toggle("editing", editMode);
    phrasesEmpty.hidden = phrases.length > 0;
    // 提示只在编辑模式下显示
    phrasesHint.hidden = !editMode || phrases.length === 0;
    phrasesHint.textContent = "点击 ✕ 删除短语，点「完成」结束编辑";
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
    phraseInput.focus(); // 连续添加更顺手
  }

  function removePhrase(p) {
    const idx = phrases.indexOf(p);
    if (idx === -1) return;
    if (isSpeaking && currentEl && currentEl.textContent.includes(p)) stop();
    phrases.splice(idx, 1);
    lastDeleted = { text: p, index: idx };
    edited = true;
    persistLocal(phrases);
    pushToServer(phrases);
    renderPhrases();
    showUndo();
  }

  // 删除撤销：底部提示条，4 秒内可恢复
  function showUndo() {
    if (!lastDeleted) return;
    undoText.textContent = "已删除「" + lastDeleted.text + "」";
    undoToast.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 4000);
  }

  function hideUndo() {
    undoToast.hidden = true;
    clearTimeout(undoTimer);
  }

  function undoDelete() {
    if (!lastDeleted) return;
    const { text, index } = lastDeleted;
    lastDeleted = null;
    if (!phrases.includes(text)) {
      phrases.splice(Math.min(index, phrases.length), 0, text);
      edited = true;
      persistLocal(phrases);
      pushToServer(phrases);
      renderPhrases();
    }
    hideUndo();
  }

  // 编辑模式开关：默认界面无删除按钮，编辑态才显示 ✕
  function toggleEdit() {
    editMode = !editMode;
    editBtn.textContent = editMode ? "完成" : "编辑";
    editBtn.classList.toggle("editing", editMode);
    renderPhrases();
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
      '<option value="zh-CN-XiaoyiNeural">晓伊（女声 · 推荐）</option>' + LOCAL_OPTION;
    const saved = localStorage.getItem(VOICE_KEY);
    if (saved) voiceSel.value = saved;
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data) => {
        if (!data || !Array.isArray(data.list)) return;
        voiceSel.innerHTML = data.list
          .map((v) => `<option value="${v.id}">${v.name}</option>`)
          .join("") + LOCAL_OPTION;
        // 仅在列表确实包含已选音色（或本地）时才回填，避免无效选择
        if (saved && (saved === "local" || data.list.some((v) => v.id === saved))) {
          voiceSel.value = saved;
        }
      })
      .catch(() => { /* 服务不可用时保持默认音色 */ });
  }

  function initStatus() {
    const viaFile = location.protocol === "file:";
    checkServer().then((ok) => {
      if (ok) { onEdge(); return; }
      if (currentVoiceId() === "local") {
        setMode("local", "本地语音"); // 用户主动选择本地，无需探测恢复
        return;
      }
      if (viaFile) {
        setMode("local", "本机语音模式");
        statusEl.title = "当前是直接打开 index.html 文件。要使用晓伊等网络语音，请运行 start.bat 后访问 http://localhost:8000";
      } else {
        setMode("local", "本机语音（等待服务…）");
        statusEl.title = "未检测到本地语音服务，每 8 秒自动重试；也可运行 start.bat 启动";
      }
      startRecovery();
    });
  }

  /* ---------- 事件 ---------- */

  // 主按钮：空闲朗读 / 播放中停止
  speakBtn.addEventListener("click", () => {
    if (isSpeaking) stop();
    else speak(input.value);
  });

  // Esc 停止朗读
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stop();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      speak(input.value);
    }
  });

  // 清空输入
  input.addEventListener("input", () => {
    clearBtn.hidden = input.value.length === 0;
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    input.focus();
  });

  addPhraseBtn.addEventListener("click", addPhrase);
  phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addPhrase(); }
  });
  editBtn.addEventListener("click", toggleEdit);
  undoBtn.addEventListener("click", undoDelete);

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
    if (isSpeaking) stop(); // 切换音色时停掉当前播放
    if (voiceSel.value === "local") {
      setMode("local", "本地语音");
      return;
    }
    // 选择网络音色：服务可用则切回，不可用则保持本地并继续探测
    checkServer().then((ok) => {
      if (ok) onEdge();
      else {
        setMode("local", "本地语音（服务不可用）");
        startRecovery();
      }
    });
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
