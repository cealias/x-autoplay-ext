/**
 * X (Twitter) 自动连播脚本
 * 功能说明：
 * 1. 网页左上角半透明悬浮按钮：“▶️ 开启连播 / ⏸ 暂停连播”及“📺 X 大屏 / 🎞️ 幕布”切换开关，支持拖拽与状态显示
 * 2. 自动平滑滚动浏览推文 article
 * 3. 遇到视频：默认优先点开 X 自带的大屏（媒体查看器）播放，保留评论、点赞、收藏等原生功能；
 *    若找不到大屏链接、3 秒内没打开或切换到“幕布”模式，则盖一层黑色幕布全屏播放（不改 X 的网页）。
 *    关闭循环 (loop = false)，视频短于 5 秒时播两遍，播完后关掉大屏/撤掉幕布滚到下一条
 * 4. 遇到单图：点开大图全屏浏览 5 秒后自动关闭大图并滚到下一条
 * 5. 遇到多图：点开第一张大图，每隔 5 秒自动切换下一张（跟随用户手动翻页），看完最后一张自动关闭大图并滚到下一条
 * 6. 遇到纯文本推文：停留 4 秒供阅读后滚到下一条
 * 7. 用户交互优先：用户主动滚动、翻图、关大图、退全屏、暂停视频或跳转页面时，脚本始终跟着用户走
 */

(function () {
  'use strict';

  // 状态变量
  let isRunning = false;
  // 每次开启/暂停都 +1。旧的循环发现号码对不上，就知道自己该停了，避免两个循环同时跑
  let runToken = 0;
  // 当前帖子：优先用帖子链接认人（X 会重新生成帖子元素，元素本身靠不住）
  let currentKey = null;
  let currentEl = null;
  // 记录自动连播已经推进到的文档纵向位置（只往下走，绝不往回跳）
  let maxReachedDocY = 0;
  // 用户声音偏好：默认 false（全屏自动开启声音）；按 M 或点静音按钮可切换并记住
  let userMutedPref = false;
  // 已经完整看完的帖子
  const doneKeys = new Set();
  const doneEls = new WeakSet();
  // 上次调用 history.back() 的时间，防止连退两次退出时间线
  let lastBackAt = 0;

  // 用户真实输入记录（只认 e.isTrusted）
  let userScrollSeq = 0;       // 用户滚动计数
  let lastUserScrollAt = 0;    // 最近一次用户滚动的时间戳
  let userActionSeq = 0;       // 用户任意操作计数（用来判断本条开始后用户有没有动过）
  let lastUserInputAt = 0;     // 最近一次用户点击/按键/触摸时间（用来判断是不是用户自己暂停了视频）
  let articleStartScrollSeq = 0;
  let articleStartActionSeq = 0;
  let isDraggingScrollbar = false;

  // 记录脚本自己打开/关闭大图与所在的时间线网址，用来区分是不是用户自己去了别的页面
  let currentHomePath = null;
  let scriptLightboxActive = false;
  let scriptLightboxStatusId = null;
  let lastScriptNavAt = 0;

  // 悬浮窗 DOM 元素
  let widgetEl = null;
  let toggleBtnEl = null;
  let statusDotEl = null;
  let statusTextEl = null;

  // -------------------------------------------------------------
  // 0a. 个性化配置系统 (Settings System) —— 保持用户最喜欢的默认参数
  // -------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    photoDuration: 5,        // 图片播放停留秒数（默认 5s）
    textDuration: 4,         // 纯文本推文阅读秒数（默认 4s）
    videoReplayEnabled: true,// 短视频是否自动重播 2 遍（默认开启）
    videoReplayThreshold: 5, // 低于多少秒视为短视频（默认 5s）
    toggleKey: 'p'           // 连播开启/暂停快捷键（默认右手最顺手的 'p' 键）
  };

  let settings = { ...DEFAULT_SETTINGS };
  let isRecordingKey = false;
  let settingsPanelEl = null;

  function loadSettings() {
    try {
      const local = localStorage.getItem('x_autoplay_settings');
      if (local) {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(local) };
      }
    } catch (_) {}

    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(['x_autoplay_settings'], (res) => {
          if (res && res.x_autoplay_settings) {
            settings = { ...DEFAULT_SETTINGS, ...res.x_autoplay_settings };
            updateSettingsUI();
          }
        });
      }
    } catch (_) {}
  }

  function saveSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    try {
      localStorage.setItem('x_autoplay_settings', JSON.stringify(settings));
    } catch (_) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ x_autoplay_settings: settings });
      }
    } catch (_) {}
    updateSettingsUI();
    updateWidgetUI();
  }

  function formatKeyDisplay(k) {
    if (!k) return '未设置';
    if (k === ' ' || k.toLowerCase() === 'space') return 'Space';
    if (k.length === 1) return k.toUpperCase();
    return k;
  }

  function isToggleHotKey(e) {
    if (isRecordingKey) return false;
    if (!settings.toggleKey) return false;
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const cur = settings.toggleKey.trim().toLowerCase();
    const pressed = e.key.toLowerCase();
    if (cur === 'space' || cur === ' ') {
      return pressed === ' ' || pressed === 'space';
    }
    return pressed === cur;
  }

  // -------------------------------------------------------------
  // 0. 全局用户输入监听（capture + passive，只认 e.isTrusted）
  // -------------------------------------------------------------
  const SCROLL_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End', 'j', 'k'];

  function isOnWidget(target) {
    return !!(target && target.closest && target.closest('#x-autoplay-widget'));
  }

  function isInsideNativeLightbox(target) {
    if (!isLightboxOpen()) return false;
    return true;
  }

  function recordUserScroll() {
    userScrollSeq++;
    lastUserScrollAt = Date.now();
    userActionSeq++;
  }

  function initUserInputListeners() {
    window.addEventListener('wheel', (e) => {
      if (!e.isTrusted || isOnWidget(e.target)) return;
      if (isInsideNativeLightbox(e.target)) return;
      recordUserScroll();
    }, { capture: true, passive: true });

    window.addEventListener('touchstart', (e) => {
      if (!e.isTrusted || isOnWidget(e.target)) return;
      userActionSeq++;
      lastUserInputAt = Date.now();
    }, { capture: true, passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!e.isTrusted || isOnWidget(e.target)) return;
      if (isInsideNativeLightbox(e.target)) return;
      lastUserInputAt = Date.now();
      recordUserScroll();
    }, { capture: true, passive: true });

    window.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || isOnWidget(e.target)) return;
      userActionSeq++;
      lastUserInputAt = Date.now();
      // 在页面滚动条上按下鼠标，目标是 document.documentElement（大屏打开时不算滚走时间线）
      if (e.target === document.documentElement && !isInsideNativeLightbox(e.target)) {
        isDraggingScrollbar = true;
        recordUserScroll();
      }
    }, { capture: true, passive: true });

    window.addEventListener('pointermove', (e) => {
      if (!e.isTrusted || !isDraggingScrollbar) return;
      if (isInsideNativeLightbox(e.target)) return;
      recordUserScroll();
    }, { capture: true, passive: true });

    const stopScrollbarDrag = () => {
      isDraggingScrollbar = false;
    };
    window.addEventListener('pointerup', stopScrollbarDrag, { capture: true, passive: true });
    window.addEventListener('pointercancel', stopScrollbarDrag, { capture: true, passive: true });

    window.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      // 检查连播开关快捷键（支持自定义，默认右手 'p' 键）
      if (isToggleHotKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleAutoplay();
        return;
      }

      if (isOnWidget(e.target)) return;

      userActionSeq++;
      // 快进快退和静音键不算暂停意图，其余按键记录用户输入时间
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'm' && e.key !== 'M') {
        lastUserInputAt = Date.now();
      }

      if (SCROLL_KEYS.includes(e.key)) {
        // 大图打开时按空格不是滚动页面
        if (isLightboxOpen() && e.key === ' ') return;
        // X 大屏打开期间，在大屏里按键盘滚动（如看评论、空格暂停），不算滚走时间线页面
        if (isInsideNativeLightbox(e.target)) return;
        recordUserScroll();
      }
    }, { capture: true, passive: false });
  }

  /** 当前这条帖子开始后，用户有没有自己滚动过页面 */
  function hasUserScrolled() {
    return userScrollSeq !== articleStartScrollSeq;
  }

  /** 当前这条帖子开始后，用户有没有做过任何操作 */
  function hasUserActed() {
    return userActionSeq !== articleStartActionSeq || userScrollSeq !== articleStartScrollSeq;
  }

  // -------------------------------------------------------------
  // 1. VITRA 极简光学悬浮小按钮与果冻物理引擎
  // -------------------------------------------------------------

  /** 动态检测 X 站主题（白昼极光 / 暗夜深空） */
  function syncVitraTheme() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor;
      const match = bg.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (match) {
        const r = parseInt(match[1], 10);
        const g = parseInt(match[2], 10);
        const b = parseInt(match[3], 10);
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        document.documentElement.setAttribute('data-xap-theme', luma > 140 ? 'day' : 'night');
        return;
      }
    } catch (_) {}
    document.documentElement.setAttribute('data-xap-theme', 'night');
  }

  function createFloatingWidget() {
    if (document.getElementById('x-autoplay-widget')) return;

    syncVitraTheme();

    widgetEl = document.createElement('div');
    widgetEl.id = 'x-autoplay-widget';
    widgetEl.className = 'layer-2-jelly';
    widgetEl.innerHTML = `
      <div class="vitra-body">
        <div class="vitra-inner-bevel"></div>
        <div class="vitra-glare"></div>
        <div class="vitra-content">
          <div class="x-autoplay-drag-handle" title="按住可拖动">
            <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
              <circle cx="2" cy="2" r="1.2"/>
              <circle cx="6" cy="2" r="1.2"/>
              <circle cx="2" cy="6" r="1.2"/>
              <circle cx="6" cy="6" r="1.2"/>
              <circle cx="2" cy="10" r="1.2"/>
              <circle cx="6" cy="10" r="1.2"/>
            </svg>
          </div>
          <div class="vitra-status-orb" title="运行状态">
            <div class="vitra-orb-glow"></div>
            <div class="vitra-orb-core x-autoplay-status-dot"></div>
          </div>
          <button type="button" class="x-autoplay-toggle-btn" id="x-autoplay-toggle-btn">
            <span class="vitra-btn-icon-wrapper"><span class="vitra-btn-icon">▶</span></span>
            <span class="x-autoplay-btn-label">连播</span>
          </button>
          <div class="x-autoplay-status-text" id="x-autoplay-status-text"></div>
          <button type="button" class="x-autoplay-settings-btn" id="x-autoplay-settings-btn" title="连播设置">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(widgetEl);

    toggleBtnEl = widgetEl.querySelector('#x-autoplay-toggle-btn');
    statusDotEl = widgetEl.querySelector('.x-autoplay-status-dot');
    statusTextEl = widgetEl.querySelector('#x-autoplay-status-text');
    const settingsBtnEl = widgetEl.querySelector('#x-autoplay-settings-btn');

    // 挂载设置面板
    const panel = createSettingsPanel();
    widgetEl.appendChild(panel);

    // 恢复历史拖拽位置
    try {
      const savedPos = localStorage.getItem('x_autoplay_widget_pos');
      if (savedPos) {
        const { top, left } = JSON.parse(savedPos);
        widgetEl.style.top = `${Math.max(10, Math.min(window.innerHeight - 60, top))}px`;
        widgetEl.style.left = `${Math.max(10, Math.min(window.innerWidth - 180, left))}px`;
      }
    } catch (e) {}

    // 绑定开启/暂停点击事件
    toggleBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAutoplay();
    });

    // 绑定设置按钮点击事件
    settingsBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsPanel();
    });

    // 点击外部区域关闭设置面板
    document.addEventListener('pointerdown', (e) => {
      if (settingsPanelEl && settingsPanelEl.classList.contains('is-open')) {
        if (!settingsPanelEl.contains(e.target) && !e.target.closest('#x-autoplay-settings-btn')) {
          closeSettingsPanel();
        }
      }
    });

    // 实时动态镜面追光跟踪
    widgetEl.addEventListener('pointermove', (e) => {
      const rect = widgetEl.getBoundingClientRect();
      widgetEl.style.setProperty('--local-x', `${(e.clientX - rect.left).toFixed(1)}px`);
      widgetEl.style.setProperty('--local-y', `${(e.clientY - rect.top).toFixed(1)}px`);
    });

    // 绑定果冻弹性拖拽物理引擎
    initDraggable(widgetEl);
    updateWidgetUI();
  }

  function updateWidgetUI() {
    if (!widgetEl) return;
    const btnLabel = toggleBtnEl.querySelector('.x-autoplay-btn-label');
    const iconSpan = toggleBtnEl.querySelector('.vitra-btn-icon');
    const settingsBtnEl = widgetEl.querySelector('#x-autoplay-settings-btn');
    const keyHint = formatKeyDisplay(settings.toggleKey);

    if (isRunning) {
      widgetEl.classList.remove('x-autoplay-paused');
      widgetEl.classList.add('x-autoplay-running');
      btnLabel.textContent = '暂停';
      if (iconSpan) iconSpan.textContent = '⏸';
      toggleBtnEl.title = `暂停连播 (快捷键: ${keyHint})`;
    } else {
      widgetEl.classList.remove('x-autoplay-running');
      widgetEl.classList.add('x-autoplay-paused');
      btnLabel.textContent = '连播';
      if (iconSpan) iconSpan.textContent = '▶';
      toggleBtnEl.title = `开启连播 (快捷键: ${keyHint})`;
      updateStatus('');
    }
    if (settingsBtnEl) {
      settingsBtnEl.title = `连播设置 (当前快捷键: ${keyHint})`;
    }
  }

  function createSettingsPanel() {
    if (settingsPanelEl) return settingsPanelEl;

    settingsPanelEl = document.createElement('div');
    settingsPanelEl.id = 'x-autoplay-settings-panel';
    settingsPanelEl.innerHTML = `
      <div class="vitra-settings-header">
        <div class="vitra-settings-title">
          <span class="vitra-settings-icon">⚙️</span>
          <span>连播个性化配置</span>
        </div>
        <button type="button" class="vitra-settings-close" id="xap-settings-close" title="关闭设置">✕</button>
      </div>
      
      <div class="vitra-settings-body">
        <!-- 图片停留秒数 -->
        <div class="vitra-setting-row">
          <div class="vitra-setting-header-line">
            <span class="vitra-setting-name">🖼️ 图片停留时长</span>
            <span class="vitra-val-badge" id="xap-val-photo">${settings.photoDuration}s</span>
          </div>
          <div class="vitra-setting-desc">单图及多图每页的浏览时间</div>
          <input type="range" min="1" max="30" step="1" value="${settings.photoDuration}" id="xap-set-photo" class="vitra-slider">
        </div>

        <!-- 纯文本推文停留秒数 -->
        <div class="vitra-setting-row">
          <div class="vitra-setting-header-line">
            <span class="vitra-setting-name">📝 文本阅读时长</span>
            <span class="vitra-val-badge" id="xap-val-text">${settings.textDuration}s</span>
          </div>
          <div class="vitra-setting-desc">纯文字推文的停留阅读时间</div>
          <input type="range" min="1" max="30" step="1" value="${settings.textDuration}" id="xap-set-text" class="vitra-slider">
        </div>

        <!-- 短视频自动重播开关 -->
        <div class="vitra-setting-row">
          <div class="vitra-setting-header-line">
            <span class="vitra-setting-name">🎬 短视频自动重播</span>
            <label class="vitra-switch">
              <input type="checkbox" id="xap-set-replay-enable" ${settings.videoReplayEnabled ? 'checked' : ''}>
              <span class="vitra-switch-slider"></span>
            </label>
          </div>
          <div class="vitra-setting-desc">遇到短视频时自动连播 2 遍</div>
        </div>

        <!-- 短视频判定阈值 -->
        <div class="vitra-setting-row" id="xap-row-threshold" style="${settings.videoReplayEnabled ? '' : 'display: none;'}">
          <div class="vitra-setting-header-line">
            <span class="vitra-setting-name">⏱️ 重播判定阈值</span>
            <span class="vitra-val-badge" id="xap-val-threshold">低于 ${settings.videoReplayThreshold}s</span>
          </div>
          <div class="vitra-setting-desc">视频时长低于该秒数时判定为短视频并重播</div>
          <input type="range" min="1" max="15" step="1" value="${settings.videoReplayThreshold}" id="xap-set-threshold" class="vitra-slider">
        </div>

        <!-- 连播开关快捷键 -->
        <div class="vitra-setting-row">
          <div class="vitra-setting-header-line">
            <span class="vitra-setting-name">⌨️ 连播开关快捷键</span>
            <button type="button" class="vitra-key-btn" id="xap-set-key" title="点击后按下键盘按键录制">
              <span class="vitra-key-name">${formatKeyDisplay(settings.toggleKey)}</span>
            </button>
          </div>
          <div class="vitra-setting-desc">网页任意位置一键开启/暂停连播（打字时不触发）</div>
        </div>
      </div>

      <div class="vitra-settings-footer">
        <button type="button" class="vitra-reset-btn" id="xap-settings-reset" title="恢复为您最喜欢的默认参数">恢复默认</button>
        <span class="vitra-saved-tip" id="xap-saved-tip">自动实时保存</span>
      </div>
    `;

    // 阻止面板内事件穿透
    ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick'].forEach(evt => {
      settingsPanelEl.addEventListener(evt, (e) => e.stopPropagation());
    });

    // 关闭按钮
    settingsPanelEl.querySelector('#xap-settings-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeSettingsPanel();
    });

    // 图片滑块
    const photoSlider = settingsPanelEl.querySelector('#xap-set-photo');
    const photoVal = settingsPanelEl.querySelector('#xap-val-photo');
    photoSlider.addEventListener('input', () => {
      const v = parseInt(photoSlider.value, 10);
      photoVal.textContent = `${v}s`;
      saveSettings({ photoDuration: v });
    });

    // 文本滑块
    const textSlider = settingsPanelEl.querySelector('#xap-set-text');
    const textVal = settingsPanelEl.querySelector('#xap-val-text');
    textSlider.addEventListener('input', () => {
      const v = parseInt(textSlider.value, 10);
      textVal.textContent = `${v}s`;
      saveSettings({ textDuration: v });
    });

    // 重播开关
    const replayCheck = settingsPanelEl.querySelector('#xap-set-replay-enable');
    const thresholdRow = settingsPanelEl.querySelector('#xap-row-threshold');
    replayCheck.addEventListener('change', () => {
      const en = replayCheck.checked;
      thresholdRow.style.display = en ? '' : 'none';
      saveSettings({ videoReplayEnabled: en });
    });

    // 阈值滑块
    const thresholdSlider = settingsPanelEl.querySelector('#xap-set-threshold');
    const thresholdVal = settingsPanelEl.querySelector('#xap-val-threshold');
    thresholdSlider.addEventListener('input', () => {
      const v = parseInt(thresholdSlider.value, 10);
      thresholdVal.textContent = `低于 ${v}s`;
      saveSettings({ videoReplayThreshold: v });
    });

    // 快捷键录制
    const keyBtn = settingsPanelEl.querySelector('#xap-set-key');
    const keyName = keyBtn.querySelector('.vitra-key-name');

    function onKeyRecord(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        stopRecordingKey();
        return;
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      saveSettings({ toggleKey: e.key });
      stopRecordingKey();
    }

    function startRecordingKey() {
      isRecordingKey = true;
      keyBtn.classList.add('is-recording');
      keyName.textContent = '按任意键...';
      window.addEventListener('keydown', onKeyRecord, true);
    }

    function stopRecordingKey() {
      isRecordingKey = false;
      keyBtn.classList.remove('is-recording');
      keyName.textContent = formatKeyDisplay(settings.toggleKey);
      window.removeEventListener('keydown', onKeyRecord, true);
    }

    keyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isRecordingKey) {
        stopRecordingKey();
      } else {
        startRecordingKey();
      }
    });

    // 恢复默认按钮
    const resetBtn = settingsPanelEl.querySelector('#xap-settings-reset');
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveSettings({ ...DEFAULT_SETTINGS });
      const tip = settingsPanelEl.querySelector('#xap-saved-tip');
      if (tip) {
        tip.textContent = '已恢复默认值！';
        setTimeout(() => { tip.textContent = '自动实时保存'; }, 1800);
      }
    });

    return settingsPanelEl;
  }

  function updateSettingsUI() {
    if (!settingsPanelEl) return;
    const photoSlider = settingsPanelEl.querySelector('#xap-set-photo');
    const photoVal = settingsPanelEl.querySelector('#xap-val-photo');
    if (photoSlider) photoSlider.value = settings.photoDuration;
    if (photoVal) photoVal.textContent = `${settings.photoDuration}s`;

    const textSlider = settingsPanelEl.querySelector('#xap-set-text');
    const textVal = settingsPanelEl.querySelector('#xap-val-text');
    if (textSlider) textSlider.value = settings.textDuration;
    if (textVal) textVal.textContent = `${settings.textDuration}s`;

    const replayCheck = settingsPanelEl.querySelector('#xap-set-replay-enable');
    const thresholdRow = settingsPanelEl.querySelector('#xap-row-threshold');
    if (replayCheck) replayCheck.checked = !!settings.videoReplayEnabled;
    if (thresholdRow) thresholdRow.style.display = settings.videoReplayEnabled ? '' : 'none';

    const thresholdSlider = settingsPanelEl.querySelector('#xap-set-threshold');
    const thresholdVal = settingsPanelEl.querySelector('#xap-val-threshold');
    if (thresholdSlider) thresholdSlider.value = settings.videoReplayThreshold;
    if (thresholdVal) thresholdVal.textContent = `低于 ${settings.videoReplayThreshold}s`;

    const keyName = settingsPanelEl.querySelector('.vitra-key-name');
    if (keyName && !isRecordingKey) keyName.textContent = formatKeyDisplay(settings.toggleKey);

    const settingsBtn = widgetEl && widgetEl.querySelector('#x-autoplay-settings-btn');
    if (settingsBtn) {
      settingsBtn.title = `连播设置 (当前快捷键: ${formatKeyDisplay(settings.toggleKey)})`;
    }
  }

  function toggleSettingsPanel() {
    if (!settingsPanelEl) {
      const panel = createSettingsPanel();
      if (widgetEl) widgetEl.appendChild(panel);
    }
    if (settingsPanelEl.classList.contains('is-open')) {
      closeSettingsPanel();
    } else {
      openSettingsPanel();
    }
  }

  function openSettingsPanel() {
    if (!settingsPanelEl) {
      const panel = createSettingsPanel();
      if (widgetEl) widgetEl.appendChild(panel);
    }
    updateSettingsUI();
    const rect = widgetEl.getBoundingClientRect();
    if (rect.bottom + 380 > window.innerHeight) {
      settingsPanelEl.classList.add('open-above');
    } else {
      settingsPanelEl.classList.remove('open-above');
    }
    settingsPanelEl.classList.add('is-open');
  }

  function closeSettingsPanel() {
    if (!settingsPanelEl) return;
    settingsPanelEl.classList.remove('is-open');
    if (isRecordingKey) {
      isRecordingKey = false;
      const keyBtn = settingsPanelEl.querySelector('#xap-set-key');
      const keyName = settingsPanelEl.querySelector('.vitra-key-name');
      if (keyBtn) keyBtn.classList.remove('is-recording');
      if (keyName) keyName.textContent = formatKeyDisplay(settings.toggleKey);
    }
  }

  /**
   * 极简状态显示：只留纯秒数（如 "5s", "12s"），长提示文字不显示在按钮上
   */
  function updateStatus(text) {
    if (!statusTextEl) return;
    if (!text) {
      statusTextEl.textContent = '';
      return;
    }
    statusTextEl.title = text; // 完整信息只在鼠标悬停 title 显示，不占界面空间
    const m = text.match(/\((\d+)s\)/) || text.match(/(\d+)s/);
    if (m) {
      statusTextEl.textContent = `${m[1]}s`;
    } else {
      statusTextEl.textContent = '';
    }
  }

  /**
   * VITRA 胡克定律果冻弹性拖拽物理引擎 (Hooke's Law Jelly Engine)
   */
  function initDraggable(el) {
    let isDragging = false;
    let startPointerX = 0, startPointerY = 0;
    let initialLeft = 0, initialTop = 0;
    let lastX = 0, lastY = 0;
    let movedDistance = 0;

    let curX = 0, curY = 0;
    let vx = 0, vy = 0;
    let scaleX = 1, scaleY = 1;
    let springRafId = null;

    function stepSpring() {
      const stiffness = 0.22;
      const damping = 0.72;

      vx = (vx + (0 - curX) * stiffness) * damping;
      vy = (vy + (0 - curY) * stiffness) * damping;
      curX += vx;
      curY += vy;

      scaleX += (1 - scaleX) * 0.18;
      scaleY += (1 - scaleY) * 0.18;

      el.style.transform = `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0) scaleX(${scaleX.toFixed(4)}) scaleY(${scaleY.toFixed(4)})`;

      const isSettled =
        Math.abs(curX) < 0.08 &&
        Math.abs(curY) < 0.08 &&
        Math.abs(vx) < 0.08 &&
        Math.abs(vy) < 0.08 &&
        Math.abs(1 - scaleX) < 0.002;

      if (!isSettled) {
        springRafId = requestAnimationFrame(stepSpring);
      } else {
        curX = 0;
        curY = 0;
        vx = 0;
        vy = 0;
        scaleX = 1;
        scaleY = 1;
        el.style.transform = 'translate3d(0, 0, 0) scale(1)';
        springRafId = null;
      }
    }

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#x-autoplay-toggle-btn') || e.target.closest('#x-autoplay-settings-btn') || e.target.closest('#x-autoplay-settings-panel')) return;

      if (springRafId) {
        cancelAnimationFrame(springRafId);
        springRafId = null;
      }

      isDragging = true;
      movedDistance = 0;
      startPointerX = e.clientX;
      startPointerY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;

      const rect = el.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      el.classList.add('is-dragging');
      scaleX = 1.03;
      scaleY = 0.96;
      el.style.transform = `translate3d(0, 0, 0) scaleX(${scaleX}) scaleY(${scaleY})`;

      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    el.addEventListener('pointermove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startPointerX;
      const deltaY = e.clientY - startPointerY;
      movedDistance = Math.hypot(deltaX, deltaY);

      const speedX = e.clientX - lastX;
      const speedY = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const dynStretchX = Math.max(0.88, Math.min(1.15, 1 + (Math.abs(speedX) - Math.abs(speedY)) * 0.0035));
      const dynStretchY = Math.max(0.88, Math.min(1.15, 1 + (Math.abs(speedY) - Math.abs(speedX)) * 0.0035));
      const rotDeg = Math.max(-5, Math.min(5, speedX * 0.12));

      const newLeft = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, initialLeft + deltaX));
      const newTop = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, initialTop + deltaY));

      el.style.left = `${newLeft}px`;
      el.style.top = `${newTop}px`;
      el.style.transform = `scaleX(${dynStretchX.toFixed(3)}) scaleY(${dynStretchY.toFixed(3)}) rotate(${rotDeg.toFixed(1)}deg)`;
    });

    const finishDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      el.classList.remove('is-dragging');

      try {
        el.releasePointerCapture(e.pointerId);
      } catch (_) {}

      if (movedDistance > 5) {
        try {
          localStorage.setItem('x_autoplay_widget_pos', JSON.stringify({
            top: parseInt(el.style.top, 10),
            left: parseInt(el.style.left, 10)
          }));
        } catch (_) {}

        vx = (e.clientX - lastX) * 0.22;
        vy = (e.clientY - lastY) * 0.22;
        curX = vx * 2;
        curY = vy * 2;
        scaleX = 1.04;
        scaleY = 0.96;
        springRafId = requestAnimationFrame(stepSpring);
      } else {
        el.style.transform = 'translate3d(0, 0, 0) scale(1)';
      }
    };

    el.addEventListener('pointerup', finishDrag);
    el.addEventListener('pointercancel', finishDrag);
  }

  // -------------------------------------------------------------
  // 2. 核心辅助工具函数与网址变化检测
  // -------------------------------------------------------------

  /** 这一轮连播是否还有效（没被暂停，也没被新的一轮顶替） */
  function alive(token) {
    return isRunning && token === runToken;
  }

  /** 记录脚本自己点开大图或视频大屏 */
  function markScriptLightboxOpen(linkEl) {
    scriptLightboxActive = true;
    lastScriptNavAt = Date.now();
    const href = (linkEl && linkEl.getAttribute('href')) || '';
    const m = href.match(/\/status\/(\d+)\/(?:photo|video)\/\d+/);
    scriptLightboxStatusId = m ? m[1] : null;
  }

  /** 记录脚本自己切换大图或关闭大图导致的网址变化 */
  function markScriptNav() {
    lastScriptNavAt = Date.now();
  }

  /** 当前网址是不是脚本自己打开的大图/视频大屏网址 */
  function isScriptLightboxUrl() {
    if (!scriptLightboxActive && Date.now() - lastScriptNavAt > 2500) return false;
    const m = location.pathname.match(/\/status\/(\d+)\/(?:photo|video)\/\d+/);
    if (!m) return false;
    if (scriptLightboxStatusId && m[1] !== scriptLightboxStatusId) return false;
    return true;
  }

  /** 用户是不是自己去了别的页面（网址变了，而且不是脚本自己打开的大图/视频大屏） */
  function hasUserLeftPage() {
    if (!currentHomePath) return false;
    if (location.pathname === currentHomePath) return false;
    if (isScriptLightboxUrl()) return false;
    return true;
  }

  /** 用户去了别的页面时立刻自动暂停连播，绝不 history.back() 拉回 */
  function pauseForPageLeave() {
    isRunning = false;
    runToken++;
    scriptLightboxActive = false;
    scriptLightboxStatusId = null;
    updateWidgetUI();
    updateStatus('你去了别的页面，已暂停连播');
  }

  /**
   * 可被暂停信号、用户滚动或自定义条件实时打断的 sleep
   * @param {number} ms 等待毫秒数
   * @param {number} token 当前轮次 token
   * @param {string|null} statusMsg 状态栏倒计时文字
   * @param {Function|Object|null} options 可选：提前唤醒函数 () => boolean，或配置 { wakeIf, ignoreUserScroll }
   * @returns {Promise<boolean>} true: 正常完成或因用户滚动/条件提前唤醒; false: 连播已暂停
   */
  function interruptibleSleep(ms, token, statusMsg = null, options = null) {
    const wakeIf = typeof options === 'function' ? options : (options && options.wakeIf);
    const ignoreUserScroll = !!(options && options.ignoreUserScroll);

    return new Promise((resolve) => {
      const step = 100;
      let elapsed = 0;

      const timer = setInterval(() => {
        if (!alive(token)) {
          clearInterval(timer);
          resolve(false);
          return;
        }

        if (hasUserLeftPage()) {
          pauseForPageLeave();
          clearInterval(timer);
          resolve(false);
          return;
        }

        if ((!ignoreUserScroll && hasUserScrolled()) || (wakeIf && wakeIf())) {
          clearInterval(timer);
          resolve(true);
          return;
        }

        elapsed += step;
        if (statusMsg) {
          const remainSec = Math.max(1, Math.ceil((ms - elapsed) / 1000));
          updateStatus(`${statusMsg} (${remainSec}s)`);
        }

        if (elapsed >= ms) {
          clearInterval(timer);
          resolve(true);
        }
      }, step);
    });
  }

  /** 等用户停止滚动（约 1.5 秒内没有新的滚动操作） */
  async function waitForUserScrollIdle(token) {
    while (alive(token)) {
      if (hasUserLeftPage()) {
        pauseForPageLeave();
        return false;
      }
      if (Date.now() - lastUserScrollAt >= 1500) break;
      updateStatus('👀 跟着你：从你停下的那条继续...');
      if (!(await interruptibleSleep(150, token, null, { ignoreUserScroll: true }))) return false;
    }
    if (!alive(token)) return false;
    updateStatus('👀 跟着你：从你停下的那条继续');
    return true;
  }

  // -------------------------------------------------------------
  // 3. 寻找与滚动到推文
  // -------------------------------------------------------------

  /** 时间线上的帖子（排除大图弹窗右侧评论区里的帖子） */
  function getAllArticles() {
    let articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (articles.length === 0) articles = Array.from(document.querySelectorAll('article'));
    articles = articles.filter(a => !a.closest('[aria-modal="true"], [role="dialog"]') && a.offsetHeight > 0);
    // X 的时间线是一格格拼起来的，代码里的先后顺序不一定等于屏幕上的上下顺序，按屏幕位置重新排
    return articles
      .map(a => ({ a, top: a.getBoundingClientRect().top }))
      .sort((x, y) => x.top - y.top)
      .map(x => x.a);
  }

  /**
   * 帖子自己的编号，比如 /NASA/status/2111180963661435219 里的那串数字。
   * 优先用发帖时间旁边的链接；X 现在的网页里常常没有 <time>，就用帖子里第一个帖子链接
   * （帖子自己的链接排在最前面，引用的别人的帖子在后面）
   */
  function getTweetId(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const link = (time && time.closest('a')) || article.querySelector('a[href*="/status/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  /** 帖子的“身份证”，用来记住哪条看过、刚才看到哪 */
  function getTweetKey(article) {
    const id = getTweetId(article);
    return id ? `status:${id}` : null;
  }

  function isDone(article) {
    const key = getTweetKey(article);
    return key ? doneKeys.has(key) : doneEls.has(article);
  }

  function markDone(article) {
    if (!article) return;
    const key = getTweetKey(article);
    if (key) doneKeys.add(key);
    doneEls.add(article);
  }

  /** 在页面上重新找到当前这条（X 重新生成元素后也能认出来） */
  function findCurrent(articles) {
    if (currentKey) {
      const found = articles.find(a => getTweetKey(a) === currentKey);
      if (found) return found;
    }
    if (currentEl && articles.includes(currentEl)) return currentEl;
    return null;
  }

  /** 帖子在屏幕里露出来的高度（顶部导航栏约 60px 不算） */
  function visibleHeight(article) {
    const rect = article.getBoundingClientRect();
    return Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 60);
  }

  /** 帖子在整个网页里的纵向位置（不随滚动变化，用来保证只往下走） */
  function docTop(article) {
    return article.getBoundingClientRect().top + window.scrollY;
  }

  /**
   * @param {boolean} fresh 刚开启/刚继续/你刚自己滚过：直接从眼前露出最多的那条开始，不管看没看过
   */
  function getNextArticle(fresh) {
    const articles = getAllArticles();
    if (articles.length === 0) return null;

    if (fresh) {
      let best = null;
      let bestH = 0;
      for (const art of articles) {
        const h = visibleHeight(art);
        if (h > bestH) {
          bestH = h;
          best = art;
        }
      }
      return best || articles[0];
    }

    // 正常连播：只往下找。位置在“已经推进到的地方”之上的帖子一律不要，
    // 这样就算 X 把看过的帖子重新生成（认不出看没看过），也不会再跳回去重播
    for (const art of articles) {
      if (docTop(art) > maxReachedDocY + 10 && !isDone(art)) return art;
    }
    return null; // 后面还没加载出来
  }

  async function scrollToArticle(article, token) {
    article.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateStatus('正在定位帖子...');
    return await interruptibleSleep(700, token);
  }

  // -------------------------------------------------------------
  // 4. 大图 / 视频弹窗的打开与关闭
  // -------------------------------------------------------------

  function isLightboxOpen() {
    return !!document.querySelector('[aria-modal="true"]') ||
           /\/(photo|video)\/\d+/.test(location.pathname);
  }

  /** 从当前网址里取出大图是第几张（/photo/N 或 /video/N），拿不到返回 null */
  function getLightboxIndex() {
    const m = location.pathname.match(/\/(?:photo|video)\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function exitNativeFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    } catch (e) {}
  }

  function closeLightbox() {
    exitNativeFullscreen();

    // 只在弹窗里找关闭按钮，免得点到页面上别的“关闭”
    const modal = document.querySelector('[aria-modal="true"]');
    if (modal) {
      markScriptNav();
      const closeBtn = modal.querySelector(
        '[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="关闭"]'
      );
      if (closeBtn) {
        closeBtn.click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        }));
      }
      return;
    }

    // 只有确认是脚本自己打开的大图网址仍停留在 /photo/1、/video/1 时，才退回时间线（1.5 秒内只退一次）
    if (isScriptLightboxUrl() && Date.now() - lastBackAt > 1500) {
      lastBackAt = Date.now();
      markScriptNav();
      history.back();
    }
  }

  /**
   * 确认大图弹窗关掉了、而且还在原来的时间线页面上，再去找下一条。
   * 如果网址变了且不是脚本自己打开的大图网址，说明用户自己去了别的页面，绝不 history.back() 拉回
   */
  async function ensureBackOnTimeline(homePath, token) {
    for (let i = 0; i < 6; i++) {
      if (location.pathname === homePath) {
        const modalOpen = !!document.querySelector('[aria-modal="true"]');
        if (!modalOpen) {
          scriptLightboxActive = false;
          scriptLightboxStatusId = null;
          return true;
        }
        if (scriptLightboxActive) {
          updateStatus('↩️ 关闭大图返回时间线...');
          closeLightbox();
        } else {
          return true;
        }
      } else if (isScriptLightboxUrl()) {
        updateStatus('↩️ 返回时间线...');
        closeLightbox();
      } else {
        // 用户自己去了别的页面：绝不调用 history.back()
        return false;
      }

      if (!(await interruptibleSleep(700, token, null, { ignoreUserScroll: true }))) return false;
    }

    if (location.pathname === homePath) {
      scriptLightboxActive = false;
      scriptLightboxStatusId = null;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------
  // 4b. 视频全屏播放控制器（给 X 原生大屏使用）
  // -------------------------------------------------------------

  let lastApplySoundAt = 0;

  /**
   * 创建无界面的控制器对象，给 X 原生大屏模式下的 waitForVideoEnd 使用。
   * 不创建任何遮挡元素，让用户直接操作 X 的大屏界面（评论、点赞、收藏、原生进度条等）。
   * 支持键盘快捷键：N = 跳过，M = 静音切换。
   */
  function createNativeLightboxOverlay(video) {
    let v = video;
    let closed = false;
    let skipped = false;
    let userPaused = false;
    let lastSeekAt = 0;

    function onSeeking() {
      lastSeekAt = Date.now();
    }

    function onSeeked() {
      lastSeekAt = Date.now();
    }

    function onPause() {
      if (Date.now() - lastSeekAt < 400) return;
      if (Date.now() - lastUserInputAt < 1000) {
        userPaused = true;
      }
    }

    function onPlay() {
      userPaused = false;
    }

    function onVolumeChange() {
      if (!v) return;
      if (Date.now() - lastUserInputAt < 800 && Date.now() - lastApplySoundAt > 150) {
        userMutedPref = !!(v.muted || v.volume === 0);
      }
    }

    function bindVideo(nv) {
      if (v) {
        v.removeEventListener('seeking', onSeeking);
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('pause', onPause);
        v.removeEventListener('play', onPlay);
        v.removeEventListener('volumechange', onVolumeChange);
      }
      v = nv;
      if (v) {
        v.addEventListener('seeking', onSeeking);
        v.addEventListener('seeked', onSeeked);
        v.addEventListener('pause', onPause);
        v.addEventListener('play', onPlay);
        v.addEventListener('volumechange', onVolumeChange);
      }
    }

    bindVideo(v);

    const onKey = (e) => {
      if (!e.isTrusted) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        e.stopPropagation();
        skipped = true;
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        e.stopPropagation();
        if (v) {
          userMutedPref = !(v.muted || v.volume === 0) ? true : false;
          soundBlocked.delete(v);
          applySound(v);
        }
      }
    };

    window.addEventListener('keydown', onKey, true);

    function close() {
      if (closed) return;
      closed = true;
      bindVideo(null);
      window.removeEventListener('keydown', onKey, true);
    }

    const api = {
      close,
      setVideo(nv) { bindVideo(nv); },
      getVideo: () => v,
      isSkipped: () => skipped,
      isExitedFullscreen: () => false,
      isScrolledOut: () => false,
      isScrubbing: () => false,
      isUserPaused: () => userPaused
    };
    return api;
  }

  // -------------------------------------------------------------
  // 5. 媒体处理逻辑（视频 / 单图 / 多图 / 纯文本）
  // -------------------------------------------------------------

  function formatTime(seconds) {
    const s = Math.floor(seconds || 0);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }

  // 被浏览器拒绝“有声自动播放”的视频，别再反复给它开声音
  const soundBlocked = new WeakSet();

  /**
   * 按用户的声音偏好给视频开/关声音。
   * X 默认把时间线视频设成静音，有时还把音量设成 0，所以光改 muted 不够，音量也要拉回来
   */
  function applySound(v) {
    if (!v) return;
    if (userMutedPref) {
      if (!v.muted) {
        lastApplySoundAt = Date.now();
        v.muted = true;
      }
      return;
    }
    if (soundBlocked.has(v)) return;
    if (v.muted) {
      lastApplySoundAt = Date.now();
      v.muted = false;
    }
    if (v.volume === 0) {
      lastApplySoundAt = Date.now();
      v.volume = 1;
    }
  }

  async function playVideo(v) {
    applySound(v);
    try {
      await v.play();
    } catch (err) {
      // 浏览器不让有声自动播放时，先静音播放保证连播不卡住（按 M 可以再打开声音）
      soundBlocked.add(v);
      lastApplySoundAt = Date.now();
      v.muted = true;
      try { await v.play(); } catch (_) {}
    }
  }

  /**
   * 在弹窗里找“现在正显示在屏幕上”的主图视频
   * 注意：
   * 1. 大图弹窗右侧是帖子正文和评论区，里面的帖子/评论都包在 <article> 里（评论里的 GIF 也是 <video>），必须排除！
   * 2. 背景时间线上的帖子也都包在 <article> 里，同样排除！
   * 3. 右侧评论栏在屏幕偏右位置（left > 屏幕宽度的 55%），主图舞台在左侧/居中，偏右的一律排除！
   */
  function getActiveModalVideo() {
    let scope = document.querySelector('[aria-modal="true"]') ||
                document.querySelector('[role="dialog"]') ||
                document.getElementById('layers');
    if (!scope && /\/(photo|video)\/\d+/.test(location.pathname)) scope = document;
    if (!scope) return null;

    let best = null;
    let maxArea = 0;
    for (const v of scope.querySelectorAll('video')) {
      // 关键：评论区里的 GIF/视频、背景时间线里的视频都包在 <article> 里，只有弹窗左侧主舞台的视频不在 <article> 里
      if (v.closest('article')) continue;

      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;

      // 排除右侧评论栏区域的视频（主舞台一定在屏幕中间或偏左）
      if (r.left > window.innerWidth * 0.55) continue;

      // 多图轮播时，左右还没翻到的视频被挪到了屏幕外面，不算
      const shownW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const shownH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (shownW < r.width * 0.6 || shownH < r.height * 0.6) continue;
      const area = r.width * r.height;
      if (area > maxArea) {
        maxArea = area;
        best = v;
      }
    }
    return best;
  }

  /**
   * 等视频播完（短于 5 秒的播两遍）
   * @param overlay     幕布或无界面替身对象（看你有没有点下一条、退出全屏、点暂停）
   * @param reacquire   X 把视频元素换掉时，用它重新找视频
   * @param shouldAbort 外部打断条件（如大图里用户自己翻页或关掉了大图）
   * @returns {Promise<'done'|'skipped'|'scrolled'|'aborted'|'lost'|'stopped'>}
   */
  function waitForVideoEnd(video, token, label, overlay, reacquire = () => null, shouldAbort = null) {
    let v = video;

    return new Promise((resolve) => {
      let plays = 0;          // 已经播完几遍
      let lastT = 0;          // 上次检查时播到哪了
      let lastEndAt = 0;      // 上次算“播完一遍”的时间，防止同一次结尾被算两遍
      let lastResumeAt = 0;   // 上次替 X 接着播的时间
      let lastSeekAt = 0;     // 最近一次 seeking/seeked 的时间，1.2 秒内不做结尾误判
      let pausedByUser = false; // 是否是用户自己点的暂停
      let noDurationMs = 0;   // 一直拿不到时长就别傻等
      let lostMs = 0;         // 视频不在网页上多久了
      let settled = false;

      const isShort = () => !!settings.videoReplayEnabled && v.duration && isFinite(v.duration) && v.duration < (settings.videoReplayThreshold || 5);
      const needPlays = () => (isShort() ? 2 : 1);

      function onSeeking() {
        lastSeekAt = Date.now();
      }

      function onSeeked() {
        lastSeekAt = Date.now();
        if (v) lastT = v.currentTime;
      }

      function onPause() {
        if (overlay && overlay.isScrubbing()) return;
        if (Date.now() - lastSeekAt < 400) return;
        // 暂停前约 1 秒内有任何用户真实输入，或者在幕布上点了暂停，就认作是用户自己暂停的
        if ((overlay && overlay.isUserPaused()) || Date.now() - lastUserInputAt < 1000) {
          pausedByUser = true;
        }
      }

      function onPlay() {
        pausedByUser = false;
      }

      function checkLoopWrap() {
        if (!v || settled) return;
        if (v.loop) v.loop = false;
        const d = v.duration;
        if (!d || !isFinite(d)) return;
        const t = v.currentTime;
        const recentlySeeked = v.seeking || (overlay && overlay.isScrubbing()) || (Date.now() - lastSeekAt < 1200);
        const wrapDrop = Math.min(0.4, d * 0.45);
        const nearEnd = d > 1.2 ? (d - 0.8) : (d * 0.55);
        if (!recentlySeeked && lastT >= nearEnd && t < lastT - wrapDrop) {
          onOnePlayDone();
          return;
        }
        if (t > lastT || t < 0.2) lastT = t;
      }

      function unbind(el) {
        if (!el) return;
        el.removeEventListener('ended', onOnePlayDone);
        el.removeEventListener('timeupdate', checkLoopWrap);
        el.removeEventListener('seeking', onSeeking);
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('play', onPlay);
      }

      function bind(nv) {
        unbind(v);
        v = nv;
        v.addEventListener('ended', onOnePlayDone);
        v.addEventListener('timeupdate', checkLoopWrap);
        v.addEventListener('seeking', onSeeking);
        v.addEventListener('seeked', onSeeked);
        v.addEventListener('pause', onPause);
        v.addEventListener('play', onPlay);
        v.loop = false;
        v.removeAttribute('loop');
        overlay.setVideo(v);
        // X 往往已经在“静音自动播放”了，视频没暂停也要把声音打开
        applySound(v);
        if (v.paused && !pausedByUser && !overlay.isUserPaused()) playVideo(v);
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        unbind(v);
        resolve(result);
      };

      function onOnePlayDone() {
        const minGap = (v && v.duration && isFinite(v.duration))
          ? Math.min(400, Math.max(120, v.duration * 350))
          : 400;
        if (Date.now() - lastEndAt < minGap) return;
        lastEndAt = Date.now();
        plays++;
        if (plays < needPlays()) {
          // 短视频：回到开头再播一遍
          v.currentTime = 0;
          lastT = 0;
          playVideo(v);
          return;
        }
        finish('done');
      }

      bind(v);

      const timer = setInterval(() => {
        if (!alive(token)) return finish('stopped');
        if (hasUserLeftPage()) {
          pauseForPageLeave();
          return finish('stopped');
        }
        if (overlay.isSkipped()) return finish('skipped');
        if (overlay.isScrolledOut() || hasUserScrolled()) return finish('scrolled');
        if (shouldAbort && shouldAbort()) return finish('aborted');

        // 视频元素不在网页上了：可能是 X 换了一个新的，找一找；2.5 秒还找不到就算丢了
        if (!document.body.contains(v)) {
          lostMs += 250;
          updateStatus('');
          const nv = reacquire();
          if (nv && document.body.contains(nv)) {
            bind(nv);
            lostMs = 0;
          } else if (lostMs >= 2500) {
            finish('lost');
          }
          return;
        }
        lostMs = 0;

        // X 有时会偷偷把循环打开，这里一直把它关掉
        if (v.loop) v.loop = false;
        // X 有时也会偷偷重新静音，按你的声音偏好改回来
        applySound(v);

        const d = v.duration;
        if (!d || !isFinite(d)) {
          noDurationMs += 250;
          updateStatus('');
          if (noDurationMs > 15000) finish('done');
          return;
        }

        const t = v.currentTime;
        const recentlySeeked = v.seeking || overlay.isScrubbing() || (Date.now() - lastSeekAt < 1200);
        const wrapDrop = Math.min(0.4, d * 0.45);
        const nearEnd = d > 1.2 ? (d - 0.8) : (d * 0.55);

        if (!recentlySeeked && lastT >= nearEnd && t < lastT - wrapDrop) {
          // 进度从结尾跳回开头 = 被 X 循环了，也算播完一遍
          onOnePlayDone();
        } else if (!recentlySeeked && v.paused && t >= d - Math.min(0.3, d * 0.25)) {
          // 停在结尾却没收到 ended 事件
          onOnePlayDone();
        } else if (v.paused) {
          if (overlay.isUserPaused() || Date.now() - lastUserInputAt < 1000) {
            pausedByUser = true;
          } else if (!pausedByUser && Date.now() - lastResumeAt > 1500) {
            // 暂停前 1 秒内没有任何用户真实输入，认为是 X 自动停的，接着放
            lastResumeAt = Date.now();
            playVideo(v);
          }
        }
        lastT = v.currentTime;

        const remainSec = Math.max(0, Math.ceil(d - t));
        updateStatus(`${remainSec}s`);
      }, 250);
    });
  }

  /**
   * 在帖子内查找属于这条帖子自己的 /status/<帖子编号>/video/N <a> 链接。
   * X 视频播放器控制栏上的“全屏”按钮（aria-label 是 “Full screen” / “全屏”）就是这样一个 <a> 链接。
   * 只返回这个 <a> 链接本身，绝不返回视频画面或外框。
   */
  function findOwnVideoLink(article, preferredN = null) {
    if (!article) return null;
    const tweetId = getTweetId(article);
    if (!tweetId) return null;

    const matched = [];
    for (const a of article.querySelectorAll('a[href*="/video/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/status\/(\d+)\/video\/(\d+)/);
      if (m && m[1] === tweetId) {
        matched.push({ n: Number(m[2]), link: a });
      }
    }
    if (matched.length === 0) {
      // 登录后的 X 时间线里没有 /video/N 链接：用帖子自己的链接拼出大屏网址，交给 page-bridge.js 去打开
      const own = getOwnStatusPath(article, tweetId);
      return own ? makeVirtualVideoLink(`${own}/video/${preferredN || 1}`) : null;
    }
    if (preferredN !== null) {
      const exact = matched.find(item => item.n === preferredN);
      if (exact) return exact.link;
    }
    return matched[0].link;
  }

  /** 帖子自己的网址，比如 /NASA/status/2111180963661435219（优先用发帖时间旁边的链接） */
  function getOwnStatusPath(article, tweetId) {
    const time = article.querySelector('a[href*="/status/"] time');
    const links = [(time && time.closest('a')), ...article.querySelectorAll('a[href*="/status/"]')];
    for (const a of links) {
      const m = a && (a.getAttribute('href') || '').match(/^(\/[^/?#]+\/status\/(\d+))/);
      if (m && m[2] === tweetId) return m[1];
    }
    return null;
  }

  /**
   * “假链接”：看起来跟真的 <a> 一样（有 href、能 click），
   * 点它的时候其实是请 page-bridge.js 在网页自己的环境里换网址，让 X 弹出它自己的视频大屏。
   * （真的 <a> 一点会整页刷新；点视频本身只会开声音/暂停。）
   */
  function makeVirtualVideoLink(href) {
    return {
      getAttribute: (name) => (name === 'href' ? href : null),
      click() {
        document.documentElement.setAttribute('data-xap-open-video', href);
        window.dispatchEvent(new Event('x-autoplay-open-video'));
      }
    };
  }

  /** 当前网址是不是指定帖子的 /status/<编号>/video/N 大屏网址 */
  function isTweetVideoLightboxUrl(tweetId) {
    const m = location.pathname.match(/\/status\/(\d+)\/video\/(\d+)/);
    if (!m) return false;
    return !tweetId || m[1] === tweetId;
  }

  /** 大屏打开后，把时间线里原来的小视频暂停，防止两个视频同时出声 */
  function pauseTimelineVideos(article, modalVideo, origVideo = null) {
    if (origVideo && origVideo !== modalVideo && !origVideo.paused) {
      try { origVideo.pause(); } catch (e) {}
    }
    if (article) {
      for (const tv of article.querySelectorAll('video')) {
        if (tv !== modalVideo && !tv.paused) {
          try { tv.pause(); } catch (e) {}
        }
      }
    }
    for (const tv of document.querySelectorAll('article video')) {
      if (tv !== modalVideo && !tv.paused) {
        try { tv.pause(); } catch (e) {}
      }
    }
  }

  /**
   * 在已经打开的 X 原生大屏里播放视频（不盖黑色幕布，使用无界面替身对象）
   */
  async function playModalVideoNatively(v, article, timelineVideo, token, label, reacquire, shouldAbort) {
    pauseTimelineVideos(article, v, timelineVideo);
    const overlay = createNativeLightboxOverlay(v);
    const wrappedReacquire = () => {
      const nv = reacquire();
      if (nv) pauseTimelineVideos(article, nv, timelineVideo);
      return nv;
    };

    const result = await waitForVideoEnd(v, token, label, overlay, wrappedReacquire, shouldAbort);

    const cur = overlay.getVideo();
    if (cur && document.body.contains(cur)) cur.pause();
    overlay.close();

    if (result === 'stopped' || !alive(token)) return false;
    if (result === 'scrolled' || hasUserScrolled()) return 'scrolled';
    if (result === 'aborted') return 'aborted';
    return result;
  }

  /**
   * 尝试点击帖子自己的 /status/<编号>/video/N 链接，用 X 原生大屏播放视频。
   * - 点开后最多等 3 秒，等网址变成 /status/编号/video/N 并用 getActiveModalVideo() 找到大屏视频。
   * - 如果 3 秒内大屏没打开或找不到大屏视频，返回 'fallback'，由调用方退回“幕布 + canvas”播放。
   * - 如果用户在 X 大屏里自己关掉了大屏，这条帖子算看完（返回 'done'），不再重新打开。
   * @returns {Promise<'done'|'skipped'|'scrolled'|'lost'|'fallback'|false>}
   */
  async function playVideoInXLightbox(article, videoLink, timelineVideo, token, label) {
    if (!videoLink) return 'fallback';

    const key = getTweetKey(article);
    const href = videoLink.getAttribute('href') || '';
    const m = href.match(/\/status\/(\d+)\/video\/(\d+)/);
    const tweetId = (m && m[1]) || getTweetId(article);

    updateStatus('🎬 正在打开 X 大屏播放视频...');
    // 点之前记录“这是脚本自己打开的大屏”，防止 ensureBackOnTimeline / hasUserLeftPage 误判
    markScriptLightboxOpen(videoLink);
    // 只点这个 <a> 链接本身，绝不点视频画面或外框
    videoLink.click();

    // 最多等 3 秒（15 * 200ms），等网址变成 /status/编号/video/N 并找到大屏里的主视频
    let modalVideo = null;
    let urlReachedVideo = false;

    for (let i = 0; i < 15; i++) {
      if (!alive(token)) {
        if (isScriptLightboxUrl()) closeLightbox();
        return false;
      }
      if (hasUserScrolled()) {
        if (isLightboxOpen()) closeLightbox();
        return 'scrolled';
      }

      if (isTweetVideoLightboxUrl(tweetId)) {
        urlReachedVideo = true;
        modalVideo = getActiveModalVideo();
        if (modalVideo) {
          pauseTimelineVideos(findArticleByKey(key) || article, modalVideo, timelineVideo);
          break;
        }
      } else if (urlReachedVideo && !isLightboxOpen()) {
        // 大屏刚打开就被用户自己关掉了：算看完，去下一条
        scriptLightboxActive = false;
        scriptLightboxStatusId = null;
        return 'done';
      }

      if (i < 14) {
        if (!(await interruptibleSleep(200, token))) {
          if (isScriptLightboxUrl()) closeLightbox();
          return false;
        }
      }
    }

    if (!alive(token)) {
      if (isScriptLightboxUrl()) closeLightbox();
      return false;
    }
    if (hasUserScrolled()) {
      if (isLightboxOpen()) closeLightbox();
      return 'scrolled';
    }
    // 用户在等待期间自己关掉了大屏：算看完，去下一条
    if (urlReachedVideo && (!isTweetVideoLightboxUrl(tweetId) || !isLightboxOpen())) {
      scriptLightboxActive = false;
      scriptLightboxStatusId = null;
      return 'done';
    }

    // 3 秒内大屏没打开，或者大屏里找不到视频：退回“幕布 + canvas”兜底播放
    if (!isTweetVideoLightboxUrl(tweetId) || !modalVideo) {
      if (isLightboxOpen() || isScriptLightboxUrl()) {
        closeLightbox();
        if (currentHomePath) {
          await ensureBackOnTimeline(currentHomePath, token);
        }
      } else {
        scriptLightboxActive = false;
        scriptLightboxStatusId = null;
      }
      return 'fallback';
    }

    // 找到了大屏视频：暂停时间线里原来的小视频，免得两个声音同时响
    const curArt = findArticleByKey(key) || article;
    pauseTimelineVideos(curArt, modalVideo, timelineVideo);

    const isStillInVideoLightbox = () => isTweetVideoLightboxUrl(tweetId) && isLightboxOpen();
    const res = await playModalVideoNatively(
      modalVideo,
      curArt,
      timelineVideo,
      token,
      label,
      getActiveModalVideo,
      () => !isStillInVideoLightbox()
    );

    if (res === false || !alive(token)) {
      if (isScriptLightboxUrl()) closeLightbox();
      return false;
    }
    if (res === 'scrolled' || hasUserScrolled()) {
      if (isLightboxOpen()) closeLightbox();
      return 'scrolled';
    }

    // 用户在 X 大屏里自己关掉了大屏（网址离开 /video/N 或 isLightboxOpen() 变为 false）：算看完，去下一条
    if (res === 'aborted' || !isStillInVideoLightbox()) {
      scriptLightboxActive = false;
      scriptLightboxStatusId = null;
      return 'done';
    }

    // 播完（或按 N 跳过、或视频丢失）后：关掉 X 大屏，回到时间线
    updateStatus('🎬 视频播放完毕，关闭大屏...');
    closeLightbox();
    await interruptibleSleep(300, token, null, { ignoreUserScroll: true });
    return res === 'lost' ? 'lost' : 'done';
  }

  /** 等一个格子里的 <video> 加载出来（X 滚到眼前才会加载，最多等 3 秒） */
  async function waitForVideoEl(scope, token) {
    const pick = () => getVisibleVideos(scope)[0] || scope.querySelector('video');
    let v = pick();
    for (let i = 0; i < 10 && !v; i++) {
      if (hasUserScrolled()) return null;
      if (i === 4) {
        // 关了自动播放时，有的视频要先点一下播放键才会出现（只点播放键，别的不点）
        const playBtn = scope.querySelector('[data-testid="playButton"]');
        if (playBtn) playBtn.click();
      }
      if (!(await interruptibleSleep(300, token))) return null;
      v = pick();
    }
    return v;
  }

  /** 按帖子身份证重新找到这条帖子（X 重新生成元素后也能找到） */
  function findArticleByKey(key) {
    if (!key) return null;
    return getAllArticles().find(a => getTweetKey(a) === key) || null;
  }

  /**
   * 单个视频：
   * 优先点开 X 原生大屏播放；若无链接或打开失败，则原地播放，不加幕布。
   * @returns true 看完；false 被暂停；'scrolled' 用户滚走了；'retry' 视频丢了，要回去重播
   */
  async function handleVideo(article, token) {
    const key = getTweetKey(article);
    let v = await waitForVideoEl(article, token);
    if (!alive(token)) return false;
    if (hasUserScrolled()) return 'scrolled';

    let curArt = findArticleByKey(key) || article;

    // 优先尝试 X 原生大屏模式
    let videoLink = findOwnVideoLink(curArt, 1);
    if (!videoLink && v) {
      for (let i = 0; i < 2 && !videoLink; i++) {
        if (!(await interruptibleSleep(250, token))) return false;
        if (hasUserScrolled()) return 'scrolled';
        curArt = findArticleByKey(key) || curArt;
        videoLink = findOwnVideoLink(curArt, 1);
      }
    }

    if (videoLink) {
      const nativeRes = await playVideoInXLightbox(curArt, videoLink, v, token, '🎬 X 大屏播放中');
      if (nativeRes === false) return false;
      if (nativeRes === 'scrolled' || hasUserScrolled()) return 'scrolled';
      if (nativeRes !== 'fallback') {
        return nativeRes === 'lost' ? 'retry' : true;
      }
    }

    // 兜底（找不到大屏链接或打开失败）：原地播放，等它播完，不加黑色幕布
    curArt = findArticleByKey(key) || curArt;
    if (!v || !document.body.contains(v)) {
      v = await waitForVideoEl(curArt, token);
      if (!alive(token)) return false;
      if (hasUserScrolled()) return 'scrolled';
    }
    if (!v) {
      return await interruptibleSleep(5000, token, null);
    }

    if (curArt) {
      const r = v.getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight) {
        v.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!(await interruptibleSleep(500, token))) return false;
        if (hasUserScrolled()) return 'scrolled';
      }
    }

    const overlay = createNativeLightboxOverlay(v);
    const reacquire = () => {
      const art = findArticleByKey(key);
      return art ? getVisibleVideos(art)[0] || null : null;
    };

    const result = await waitForVideoEnd(v, token, '🎬 原地播放', overlay, reacquire);
    overlay.close();
    if (result === 'stopped' || !alive(token)) return false;
    if (result === 'scrolled' || hasUserScrolled()) return 'scrolled';
    return result === 'lost' ? 'retry' : true;
  }

  /** 帖子里看得见的视频（藏起来的、极小的备用视频不算） */
  function getVisibleVideos(article) {
    return Array.from(article.querySelectorAll('video')).filter(v => v.offsetWidth > 50 && v.offsetHeight > 50);
  }

  function isVideoBox(el) {
    return !!(el.matches('[data-testid="videoPlayer"], [data-testid="videoComponent"]') ||
              el.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]'));
  }

  /**
   * 看看帖子里有什么：几张图、几个视频、哪几格能点开大图。
   * X 现在的网页里几乎没有 data-testid 这类标记，所以主要靠两样东西：
   *   1. 每张图都有一个 /status/编号/photo/第几张 的链接（视频有时是 /video/第几个）
   *   2. 视频就是 <video> 标签
   * 老版网页的 data-testid 标记如果有，也顺便参考
   */
  function analyzeMedia(article) {
    const id = getTweetId(article);

    const found = [];
    for (const a of article.querySelectorAll('a[href*="/photo/"], a[href*="/video/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)\/(photo|video)\/(\d+)/);
      if (m) {
        const hasVideo = !!(a.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]') ||
                            a.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]'));
        found.push({ status: m[1], kind: m[2], n: Number(m[3]), link: a, hasVideo });
      }
    }
    // 优先用这条帖子自己的图；它自己没有图的话（比如图在引用的帖子里），就用引用帖子的
    const useStatus = found.some(f => f.status === id) ? id : (found[0] && found[0].status);
    const slots = new Map(); // 第几格（从 1 开始）-> { kind, link, hasVideo }
    for (const f of found) {
      if (f.status === useStatus && !slots.has(f.n)) slots.set(f.n, f);
    }

    // 老版网页的格子标记
    let boxes = Array.from(article.querySelectorAll(
      '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]'
    ));
    boxes = boxes.filter(el => !boxes.some(o => o !== el && o.contains(el)));
    const boxVideos = boxes.filter(isVideoBox).length;
    const boxPhotos = boxes.length - boxVideos;

    const videos = getVisibleVideos(article);
    const linkPhotos = [...slots.values()].filter(s => s.kind === 'photo').length;
    const linkVideos = [...slots.values()].filter(s => s.kind === 'video').length;
    const mediaImgs = article.querySelectorAll('img[src*="pbs.twimg.com/media"]').length;

    const photoCount = linkPhotos || boxPhotos || mediaImgs;
    const videoCount = Math.max(videos.length, linkVideos, boxVideos);
    const maxSlot = slots.size ? Math.max(...slots.keys()) : 0;
    const total = Math.max(photoCount + videoCount, maxSlot);
    const firstSlot = slots.size ? Math.min(...slots.keys()) : -1;

    return { slots, videos, photoCount, videoCount, total, firstSlot };
  }

  /** 单图：点开大图全屏按配置秒数浏览，然后关掉（如果用户自己关掉了大图，立刻结束去下一条） */
  async function handleSinglePhoto(m, token) {
    if (hasUserScrolled()) return 'scrolled';
    const photoDurationMs = (settings.photoDuration || 5) * 1000;
    const slot = m.slots.get(m.firstSlot);
    if (!slot || slot.kind !== 'photo') {
      // 打不开大图（比如是卡片链接），就原地看配置秒数
      return await interruptibleSleep(photoDurationMs, token, '🖼️ 图片欣赏中');
    }

    updateStatus('🖼️ 单图点开全屏浏览...');
    markScriptLightboxOpen(slot.link);
    slot.link.click();

    if (!(await interruptibleSleep(700, token))) {
      closeLightbox();
      return false;
    }
    if (hasUserScrolled()) {
      if (isLightboxOpen()) closeLightbox();
      return 'scrolled';
    }
    // 用户已经把大图关了：直接结束这条，不再重新打开也不再等
    if (!isLightboxOpen()) {
      scriptLightboxActive = false;
      return true;
    }

    // 等设定的秒数，但如果用户自己关掉了大图，立刻提前结束
    if (!(await interruptibleSleep(photoDurationMs, token, '🖼️ 单图全屏欣赏中', () => !isLightboxOpen()))) {
      if (isLightboxOpen()) closeLightbox();
      return false;
    }
    if (hasUserScrolled()) {
      if (isLightboxOpen()) closeLightbox();
      return 'scrolled';
    }
    if (!isLightboxOpen()) {
      scriptLightboxActive = false;
      return true;
    }

    updateStatus('🖼️ 单图浏览完毕，关闭大图...');
    closeLightbox();
    return true;
  }

  /**
   * 多个媒体（可能图片和视频混着）：
   * 轮到图片停 5 秒，轮到视频优先用 X 大屏播放（打不开或设为幕布模式时用幕布播完），再翻下一张；最后一个看完关掉。
   * 如果用户自己翻了图（网址里的 /photo/N 或 /video/N 变了），跟着用户从那一张重新计时 5 秒。
   * 如果用户自己关掉了大图，立刻结束这条去下一条。
   */
  async function handleGallery(article, m, token) {
    const total = m.total;
    const key = getTweetKey(article);

    // 1. 排在第一个大图链接前面的格子没有链接，一般是视频：优先找 /video/N 链接点开 X 大屏播，兜底用幕布播
    const before = m.firstSlot === -1 ? total : m.firstSlot - 1;
    for (let i = 0; i < before; i++) {
      if (hasUserScrolled()) return 'scrolled';
      const tag = `(${i + 1}/${total})`;
      const curArt = findArticleByKey(key) || article;
      let v = getVisibleVideos(curArt)[i] || m.videos[i];

      if (v) {
        let handledByNative = false;
        const videoLink = findOwnVideoLink(curArt, i + 1);
        if (videoLink) {
          const nativeRes = await playVideoInXLightbox(curArt, videoLink, v, token, `🎬 X 大屏播放中 ${tag}`);
          if (nativeRes === false) return false;
          if (nativeRes === 'scrolled' || hasUserScrolled()) return 'scrolled';
          if (nativeRes !== 'fallback') {
            handledByNative = true;
            // 如果后面还有别的格子要看，先确认已经回到时间线
            if ((i + 1 < before || m.firstSlot !== -1) && currentHomePath) {
              if (!(await ensureBackOnTimeline(currentHomePath, token))) return false;
            }
          }
        }

        if (!handledByNative) {
          const freshArt = findArticleByKey(key) || curArt;
          v = getVisibleVideos(freshArt)[i] || v;
          const reacquire = () => {
            const art = findArticleByKey(key);
            return art ? getVisibleVideos(art)[i] || null : null;
          };
          const overlay = createNativeLightboxOverlay(v);
          const res = await waitForVideoEnd(v, token, `🎬 视频 ${tag}`, overlay, reacquire);
          overlay.close();
          if (res === false || res === 'stopped') return false;
          if (res === 'scrolled' || hasUserScrolled()) return 'scrolled';
          if (res === 'skipped') return true;
        }
      } else if (!(await interruptibleSleep((settings.photoDuration || 5) * 1000, token, `🖼️ 图片 ${tag}`))) {
        return false;
      }
      if (hasUserScrolled()) return 'scrolled';
    }
    if (m.firstSlot === -1) return true;

    // 2. 点开第一个大图链接，在大图里往后看（全程跟着网址里的第几张走）
    updateStatus(`🖼️ 共 ${total} 个图片/视频，准备点开全屏...`);
    const freshArtForLink = findArticleByKey(key) || article;
    const refreshedM = analyzeMedia(freshArtForLink);
    const firstSlotObj = m.slots.get(m.firstSlot) || refreshedM.slots.get(refreshedM.firstSlot);
    if (!firstSlotObj || !firstSlotObj.link) return true;
    const firstLink = firstSlotObj.link;
    markScriptLightboxOpen(firstLink);
    firstLink.click();

    if (!(await interruptibleSleep(700, token))) {
      if (isLightboxOpen()) closeLightbox();
      return false;
    }
    if (hasUserScrolled()) {
      if (isLightboxOpen()) closeLightbox();
      return 'scrolled';
    }
    if (!isLightboxOpen()) {
      scriptLightboxActive = false;
      return true;
    }

    let fallbackN = m.firstSlot;
    let lastScriptFromN = null;

    while (alive(token)) {
      if (hasUserScrolled()) {
        if (isLightboxOpen()) closeLightbox();
        return 'scrolled';
      }
      // 用户自己把大图关了：这条立刻结束，去下一条
      if (!isLightboxOpen()) {
        scriptLightboxActive = false;
        return true;
      }

      // 优先以网址里的 /photo/N 或 /video/N 作为当前是第几张；拿不到时才用脚本自己的计数
      const urlN = getLightboxIndex();
      let n;
      if (urlN !== null && urlN !== lastScriptFromN) {
        n = urlN;
        fallbackN = urlN;
        lastScriptFromN = null;
      } else {
        n = fallbackN;
      }

      const tag = `(${n}/${total})`;
      const slot = m.slots.get(n);
      const watchBaseUrlN = getLightboxIndex();
      const didSlideChange = () => {
        const curUrlN = getLightboxIndex();
        if (watchBaseUrlN !== null) return curUrlN !== null && curUrlN !== watchBaseUrlN;
        return curUrlN !== null && curUrlN !== n;
      };

      // 判断当前这一格是不是纯静态图片（链接是 /photo/N、格子里没有视频、且网址也不是 /video/N）
      const isPurePhotoSlot = !!(
        m.videoCount === 0 ||
        (slot && slot.kind === 'photo' && !slot.hasVideo && !/\/video\/\d+/.test(location.pathname))
      );

      let v = null;
      if (!isPurePhotoSlot) {
        const rounds = (slot && slot.kind === 'photo') ? 1 : 8;
        for (let k = 0; k < rounds && !v; k++) {
          if (!isLightboxOpen() || hasUserScrolled() || didSlideChange()) break;
          v = getActiveModalVideo();
          if (!v && k < rounds - 1) {
            if (!(await interruptibleSleep(300, token, null, () => !isLightboxOpen() || didSlideChange()))) {
              if (isLightboxOpen()) closeLightbox();
              return false;
            }
          }
        }
      }

      if (hasUserScrolled()) {
        if (isLightboxOpen()) closeLightbox();
        return 'scrolled';
      }
      if (!isLightboxOpen()) {
        scriptLightboxActive = false;
        return true;
      }
      // 等待期间用户自己翻到了别的图：跟着用户，从新的那张重新开始计时
      if (didSlideChange()) {
        fallbackN = getLightboxIndex() || fallbackN;
        lastScriptFromN = null;
        continue;
      }

      if (v) {
        const res = await playModalVideoNatively(
          v,
          findArticleByKey(key) || article,
          null,
          token,
          `🎬 X 大屏播放中 ${tag}`,
          getActiveModalVideo,
          () => !isLightboxOpen() || didSlideChange()
        );
        if (res === false) {
          if (isLightboxOpen()) closeLightbox();
          return false;
        }
        if (res === 'scrolled' || hasUserScrolled()) {
          if (isLightboxOpen()) closeLightbox();
          return 'scrolled';
        }
        if (res === 'skipped') {
          if (isLightboxOpen()) closeLightbox();
          return true;
        }
      } else {
        if (!(await interruptibleSleep((settings.photoDuration || 5) * 1000, token, `🖼️ 全屏大图 ${tag}`, () => !isLightboxOpen() || didSlideChange()))) {
          if (isLightboxOpen()) closeLightbox();
          return false;
        }
      }

      if (hasUserScrolled()) {
        if (isLightboxOpen()) closeLightbox();
        return 'scrolled';
      }
      // 用户自己把大图关了：立刻结束这条去下一条
      if (!isLightboxOpen()) {
        scriptLightboxActive = false;
        return true;
      }
      // 正在等的 5 秒（或视频播放）被用户自己翻图打断：直接跟着用户从新图重新计时，不要再额外点“下一张”
      if (didSlideChange()) {
        fallbackN = getLightboxIndex() || fallbackN;
        lastScriptFromN = null;
        continue;
      }

      // 只有当“最后一张”看完时，才跳出循环关闭大图、去下一条
      if (n >= total) {
        break;
      }

      lastScriptFromN = urlN;
      fallbackN = n + 1;
      markScriptNav();
      clickNextImage();

      if (!(await interruptibleSleep(500, token, null, () => !isLightboxOpen()))) {
        if (isLightboxOpen()) closeLightbox();
        return false;
      }
    }

    updateStatus('🖼️ 全部看完，关闭大图...');
    closeLightbox();
    return true;
  }

  function clickNextImage() {
    const modal = document.querySelector('[aria-modal="true"]') || document;
    const nextBtn = modal.querySelector(
      '[aria-label="Next slide"], [aria-label="Next"], [aria-label="下一张"], [aria-label="下一张幻灯片"], [data-testid="app-bar-next"]'
    );
    if (nextBtn) {
      nextBtn.click();
      return;
    }
    // 找不到按钮就按键盘右箭头（从当前焦点发出去，X 才收得到）
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true
    }));
  }

  /** 纯文本推文：停留配置秒数 */
  async function handlePlainText(token) {
    return await interruptibleSleep((settings.textDuration || 4) * 1000, token, '📝 文字阅读中');
  }

  // -------------------------------------------------------------
  // 6. 单条推文主流程调度
  // -------------------------------------------------------------

  /** @returns true 看完；false 被暂停；'scrolled' 用户滚走了；'retry' 要回去重新看这条 */
  async function processArticle(article, token) {
    // 留 300ms 给延迟加载的视频标签
    if (!(await interruptibleSleep(300, token))) return false;
    if (hasUserScrolled()) return 'scrolled';

    let m = analyzeMedia(article);
    if (m.total === 0) {
      // 可能图片/视频还没加载出来，再等一下看一眼
      if (!(await interruptibleSleep(600, token))) return false;
      if (hasUserScrolled()) return 'scrolled';
      m = analyzeMedia(article);
    }

    // 两个及以上的图片/视频：一个个看（视频会播完）
    if (m.total >= 2) return await handleGallery(article, m, token);
    if (m.videoCount === 1) return await handleVideo(article, token);
    if (m.photoCount === 1) return await handleSinglePhoto(m, token);

    return await handlePlainText(token);
  }

  // -------------------------------------------------------------
  // 7. 主自动连播循环
  // -------------------------------------------------------------

  async function startAutoplayLoop(token) {
    updateStatus('正在寻找帖子...');
    // fresh：从眼前这条开始；next：看下一条；again：回去重看当前这条
    let mode = 'fresh';
    const homePath = location.pathname; // 开启连播时所在的页面（一般是首页时间线）
    currentHomePath = homePath;
    scriptLightboxActive = false;
    scriptLightboxStatusId = null;
    maxReachedDocY = 0;
    const retries = new Map();          // 每条帖子最多重看 2 次，防止卡在一条上

    while (alive(token)) {
      if (!(await ensureBackOnTimeline(homePath, token))) {
        if (!alive(token)) break;
        // 退不回去：说明你自己去了别的页面，直接暂停连播，绝不拉回
        pauseForPageLeave();
        break;
      }
      if (!alive(token)) break;

      // 如果找下一条之前用户正在滚动，先等用户停下并用 fresh 模式
      if (hasUserScrolled()) {
        if (!(await waitForUserScrollIdle(token))) break;
        mode = 'fresh';
      }

      let article = null;
      if (mode === 'again') article = findCurrent(getAllArticles());
      if (!article) article = getNextArticle(mode === 'fresh');

      if (!article) {
        // 后面没帖子了：往下滚触发加载更多
        articleStartScrollSeq = userScrollSeq;
        articleStartActionSeq = userActionSeq;
        updateStatus('加载更多帖子中...');
        window.scrollBy({ top: 800, behavior: 'smooth' });
        if (!(await interruptibleSleep(1500, token))) break;
        if (hasUserScrolled()) {
          if (!(await waitForUserScrollIdle(token))) break;
          mode = 'fresh';
        }
        continue;
      }

      // 记下已经推进到哪：自动连播只往下走；你自己滚过（fresh）就从你停下的位置重新算
      const top = docTop(article);
      maxReachedDocY = mode === 'fresh' ? top : Math.max(maxReachedDocY, top);

      mode = 'next';
      currentEl = article;
      currentKey = getTweetKey(article);
      // 记录这条帖子开始时的用户操作计数
      articleStartScrollSeq = userScrollSeq;
      articleStartActionSeq = userActionSeq;

      if (!(await scrollToArticle(article, token))) break;

      // 定位过程中用户自己滚动了页面：这条立刻算看过，等用户停下后从新位置继续
      if (hasUserScrolled()) {
        markDone(article);
        if (!(await waitForUserScrollIdle(token))) break;
        mode = 'fresh';
        continue;
      }

      // 滚动过程中 X 可能重新生成了这条帖子，按身份证重新找一次
      article = findCurrent(getAllArticles()) || article;
      currentEl = article;

      const result = await processArticle(article, token);

      // 被暂停的话，这条不算看过，下次开启会从它重新开始
      if (!alive(token)) break;

      // 观看过程中用户自己滚动了页面：当前这条立刻结束算看过，不滚回去，等用户停下后接着播
      if (result === 'scrolled' || hasUserScrolled()) {
        markDone(article);
        if (isLightboxOpen()) closeLightbox();
        if (!(await waitForUserScrollIdle(token))) break;
        mode = 'fresh';
        continue;
      }

      // 视频丢了：只在它还在网页上时原地重播（最多 2 次），找不到就直接往下走，绝不滚回去找
      if (result === 'retry' && !hasUserActed()) {
        const id = currentKey || 'no-key';
        const n = (retries.get(id) || 0) + 1;
        retries.set(id, n);
        if (n <= 2 && findCurrent(getAllArticles())) {
          updateStatus('🔁 视频丢了，原地重新播...');
          mode = 'again';
          continue;
        }
      }

      markDone(article);
      if (!(await interruptibleSleep(300, token))) break;
      if (hasUserScrolled()) {
        if (!(await waitForUserScrollIdle(token))) break;
        mode = 'fresh';
      }
    }
  }

  // -------------------------------------------------------------
  // 8. 开启 / 暂停连播控制
  // -------------------------------------------------------------

  function toggleAutoplay() {
    isRunning = !isRunning;
    runToken++; // 旧循环看到号码变了会自己收尾（关弹窗、停视频）
    updateWidgetUI();
    if (!isRunning) {
      currentHomePath = null;
      scriptLightboxActive = false;
      scriptLightboxStatusId = null;
    }

    if (isRunning) {
      startAutoplayLoop(runToken);
    }
  }

  // -------------------------------------------------------------
  // 9. 脚本初始化启动
  // -------------------------------------------------------------

  function init() {
    loadSettings();
    initUserInputListeners();
    createFloatingWidget();
    // 监听 URL 变化或页面重载以保持悬浮按钮始终存在
    const observer = new MutationObserver(() => {
      if (!document.getElementById('x-autoplay-widget') && document.body) {
        createFloatingWidget();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
