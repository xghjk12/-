/*!
 * 轻音播放 · Demo 交互层 (app.js)
 *
 * 说明：
 *   - 所有数据来自 core.js 的模拟曲库，不读取真实文件、不播放真实音频
 *   - 进度条按"演示速度"推进，用于观察自动切歌、播放模式与队列行为
 *   - 纯逻辑一律委托给 core.js（已由 core.test.cjs 覆盖），本文件只负责状态编排与渲染
 */
(function () {
  'use strict';

  var C = window.LiteCore;

  /* ==================== 常量 ==================== */

  var STORAGE_KEY = 'lite-player-demo-v1';
  var SCAN_INTERVAL = 68;            // 每首曲目的模拟解析耗时（毫秒）
  var SPEEDS = [1, 4, 16];           // 演示推进速度
  var FOLDER = { name: '轻音收藏', path: '/音乐/轻音收藏' };

  var VIEW_META = {
    all: { title: '全部曲目', sub: '按专辑曲序排列，双击任意曲目开始播放' },
    artists: { title: '艺术家', sub: '点击卡片可筛选该艺术家下的全部曲目' },
    albums: { title: '专辑', sub: '点击卡片可筛选该专辑下的全部曲目' },
    recent: { title: '最近添加', sub: '最近加入曲库的 10 首曲目' },
    unsupported: { title: '不支持格式', sub: '浏览器无法解码这些文件，播放时会自动跳过' }
  };

  var VOL_ON = '<path d="M5 9v6h3.2L13 19V5L8.2 9H5z"/>' +
    '<path d="M15.6 8.6a5 5 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  var VOL_OFF = '<path d="M5 9v6h3.2L13 19V5L8.2 9H5z"/>' +
    '<path d="M16 9.6l4 4.8M20 9.6l-4 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  var ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
  var ICON_PAUSE = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';

  /* ==================== 小工具 ==================== */

  function $(id) { return document.getElementById(id); }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 由字符串稳定地推导出一个渐变色，用于模拟专辑封面 */
  function coverGradient(seed) {
    var text = String(seed || '?');
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return 'linear-gradient(140deg, hsl(' + hash + ' 58% 50%), hsl(' + ((hash + 46) % 360) + ' 52% 34%))';
  }

  /* ==================== 状态 ==================== */

  function createInitialState() {
    return {
      imported: false,
      folderName: '',
      tracks: [],
      view: 'all',
      query: '',
      sortKey: 'default',
      sortDir: 'asc',
      queue: [],
      order: [],
      currentIndex: -1,
      mode: 'sequence',
      playing: false,
      progress: 0,
      volume: 0.8,
      muted: false,
      speed: 1,
      speedIndex: 0,
      selectedId: null
    };
  }

  var state = createInitialState();
  var trackMap = {};
  var tickTimer = null;
  var scanTimer = null;

  /* ==================== DOM 引用 ==================== */

  var dom = {
    // 侧栏
    btnPick: $('btnPick'),
    folderPath: $('folderPath'),
    folderMeta: $('folderMeta'),
    nav: $('nav'),
    cntAll: $('cntAll'),
    cntArtists: $('cntArtists'),
    cntAlbums: $('cntAlbums'),
    cntRecent: $('cntRecent'),
    cntUnsupported: $('cntUnsupported'),
    libStat: $('libStat'),
    btnReset: $('btnReset'),
    // 主区
    viewTitle: $('viewTitle'),
    viewSub: $('viewSub'),
    search: $('search'),
    sortKey: $('sortKey'),
    btnSortDir: $('btnSortDir'),
    btnPlayAll: $('btnPlayAll'),
    content: $('content'),
    // 播放条
    nowCover: $('nowCover'),
    nowTitle: $('nowTitle'),
    nowArtist: $('nowArtist'),
    btnMode: $('btnMode'),
    btnPrev: $('btnPrev'),
    btnPlay: $('btnPlay'),
    btnNext: $('btnNext'),
    btnDrawer: $('btnDrawer'),
    playIcon: $('playIcon'),
    tNow: $('tNow'),
    tTotal: $('tTotal'),
    progress: $('progress'),
    progressFill: $('progressFill'),
    progressKnob: $('progressKnob'),
    btnMute: $('btnMute'),
    volume: $('volume'),
    btnSpeed: $('btnSpeed'),
    // 抽屉
    drawer: $('drawer'),
    drawerBackdrop: $('drawerBackdrop'),
    drawerBody: $('drawerBody'),
    btnCloseDrawer: $('btnCloseDrawer'),
    btnClearQueue: $('btnClearQueue'),
    // 弹窗
    folderModal: $('folderModal'),
    pickStep: $('pickStep'),
    scanStep: $('scanStep'),
    crumb: $('crumb'),
    fileList: $('fileList'),
    btnPickCancel: $('btnPickCancel'),
    btnPickConfirm: $('btnPickConfirm'),
    scanFile: $('scanFile'),
    scanFill: $('scanFill'),
    scanCount: $('scanCount'),
    scanWarn: $('scanWarn'),
    // 提示
    toasts: $('toasts')
  };

  /* ==================== 持久化 ==================== */

  function save() {
    var track = currentTrack();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        imported: state.imported,
        folderName: state.folderName,
        mode: state.mode,
        volume: state.volume,
        muted: state.muted,
        sortKey: state.sortKey,
        sortDir: state.sortDir,
        currentId: track ? track.id : null,
        progress: state.progress
      }));
    } catch (err) {
      /* 隐私模式等场景下写入失败，不影响演示 */
    }
  }

  function loadSaved() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      return null;
    }
  }

  /**
   * 恢复上次状态。
   * 真实版本会从 IndexedDB 读曲库缓存与目录句柄；这里用同一份模拟曲库代替，
   * 目的是演示"关掉再打开，曲库、音量、播放位置都还在"的流程。
   */
  function restore() {
    var saved = loadSaved();
    if (!saved) return;

    if (C.isValidMode(saved.mode)) state.mode = saved.mode;
    if (typeof saved.volume === 'number') state.volume = clamp(saved.volume, 0, 1);
    state.muted = !!saved.muted;
    if (C.SORT_KEYS.indexOf(saved.sortKey) !== -1) state.sortKey = saved.sortKey;
    if (saved.sortDir === 'desc' || saved.sortDir === 'asc') state.sortDir = saved.sortDir;

    if (!saved.imported) return;

    state.tracks = C.createMockLibrary();
    trackMap = indexTracks(state.tracks);
    state.imported = true;
    state.folderName = saved.folderName || FOLDER.name;

    if (saved.currentId && trackMap[saved.currentId]) {
      state.queue = C.buildQueue(state.tracks);
      state.currentIndex = state.queue.indexOf(saved.currentId);
      state.selectedId = saved.currentId;
      var track = trackMap[saved.currentId];
      state.progress = clamp(Number(saved.progress) || 0, 0, Math.max(0, track.duration - 1));
      if (state.mode === 'shuffle') reshuffle(state.currentIndex);
    }
  }

  function indexTracks(tracks) {
    var map = {};
    tracks.forEach(function (t) { map[t.id] = t; });
    return map;
  }

  /* ==================== 队列辅助 ==================== */

  function trackAt(index) {
    var id = state.queue[index];
    return id ? (trackMap[id] || null) : null;
  }

  function currentTrack() {
    return state.currentIndex >= 0 ? trackAt(state.currentIndex) : null;
  }

  /** 重新洗牌；anchorIndex 会被放到序列首位，保证连续播放不重复 */
  function reshuffle(anchorIndex) {
    var length = state.queue.length;
    var order = C.shuffleOrder(length);
    if (typeof anchorIndex === 'number' && anchorIndex >= 0 && anchorIndex < length) {
      order = order.filter(function (i) { return i !== anchorIndex; });
      order.unshift(anchorIndex);
    }
    state.order = order;
  }

  /* ==================== 视图数据 ==================== */

  function visibleTracks() {
    var list;

    if (state.view === 'unsupported') {
      list = state.tracks.filter(function (t) { return !t.supported; });
    } else if (state.view === 'recent') {
      list = state.tracks.slice().sort(function (a, b) { return b.addedAt - a.addedAt; }).slice(0, 10);
    } else {
      list = state.tracks.slice();
    }

    list = C.filterTracks(list, state.query);
    list = C.sortTracks(list, state.sortKey, state.sortDir);
    if (state.sortKey === 'default' && state.sortDir === 'desc') list = list.reverse();
    return list;
  }

  /* ==================== 渲染：侧栏与顶栏 ==================== */

  function renderSidebar() {
    var summary = C.summarizeLibrary(state.tracks);

    dom.folderPath.textContent = state.imported ? FOLDER.path : '未选择文件夹';
    dom.folderMeta.textContent = state.imported
      ? summary.total + ' 首曲目 · ' + C.formatDuration(summary.duration)
      : '曲库为空';

    dom.cntAll.textContent = summary.total;
    dom.cntArtists.textContent = summary.artistCount;
    dom.cntAlbums.textContent = summary.albumCount;
    dom.cntRecent.textContent = Math.min(10, summary.total);
    dom.cntUnsupported.textContent = summary.unsupported;

    dom.libStat.innerHTML = state.imported
      ? '已缓存 ' + summary.total + ' 首曲目的元数据<br>共 ' + summary.albumCount + ' 张专辑 · ' +
        summary.artistCount + ' 位艺术家' +
        (summary.unsupported ? '<br><span style="color:var(--warn)">' + summary.unsupported + ' 首格式不受支持</span>' : '')
      : '曲库为空，先选择一个音乐文件夹';

    Array.prototype.forEach.call(dom.nav.querySelectorAll('.nav-item'), function (item) {
      item.classList.toggle('is-active', item.dataset.view === state.view);
    });
  }

  function renderToolbar() {
    var meta = VIEW_META[state.view] || VIEW_META.all;
    var list = visibleTracks();

    dom.viewTitle.textContent = meta.title;
    dom.viewSub.textContent = state.imported
      ? (state.query
        ? '筛选 “' + state.query + '” · ' + list.length + ' 首'
        : meta.sub + ' · 共 ' + list.length + ' 首')
      : '尚未导入曲库';

    dom.search.disabled = !state.imported;
    dom.sortKey.disabled = !state.imported;
    dom.btnSortDir.disabled = !state.imported;
    dom.btnPlayAll.disabled = !state.imported || list.length === 0;

    dom.sortKey.value = state.sortKey;
    dom.btnSortDir.textContent = state.sortDir === 'asc' ? '↑' : '↓';
    dom.btnSortDir.title = state.sortDir === 'asc' ? '当前升序，点击改为降序' : '当前降序，点击改为升序';
    dom.btnPlayAll.textContent = state.view === 'unsupported' ? '全部尝试播放' : '播放全部';
  }

  /* ==================== 渲染：曲目列表 ==================== */

  function renderContent() {
    if (!state.imported) {
      dom.content.innerHTML = emptyStateHtml();
      return;
    }

    if (state.view === 'artists' || state.view === 'albums') {
      dom.content.innerHTML = groupsHtml(state.view === 'artists' ? 'artist' : 'album');
      return;
    }

    var list = visibleTracks();
    if (!list.length) {
      dom.content.innerHTML =
        '<div class="empty"><div class="empty-mark">∅</div><h2>没有匹配的曲目</h2>' +
        '<p>试试换个关键词，或切换到其他视图。</p></div>';
      return;
    }

    dom.content.innerHTML = listHeadHtml() + list.map(trackRowHtml).join('');
  }

  function emptyStateHtml() {
    return '<div class="empty">' +
      '<div class="empty-mark">♪</div>' +
      '<h2>还没有曲库</h2>' +
      '<p>选择一个音乐文件夹，播放器会递归扫描其中的音频文件，读取标签与内嵌封面，并把结果缓存到本地。</p>' +
      '<button class="btn-primary" id="emptyPick">选择音乐文件夹</button>' +
      '<div class="empty-hint">' +
      '<b>关于这个 Demo：</b>不会读取你的任何文件。点击后会模拟一次目录选择与元数据解析过程，' +
      '随后用 24 首模拟曲目演示完整操作流程。<br>' +
      '<b>音频不会真实播放：</b>进度按演示速度推进，用于观察自动切歌、播放模式与队列行为。' +
      '</div></div>';
  }

  function listHeadHtml() {
    function head(label, key) {
      var cls = state.sortKey === key ? ' class="is-sorted"' : '';
      var sortAttr = key ? ' data-sort="' + key + '"' : '';
      return '<span' + cls + sortAttr + '>' + label + '</span>';
    }
    return '<div class="list-head">' +
      '<span>#</span>' +
      head('标题', 'title') +
      head('艺术家', 'artist') +
      head('专辑', 'album') +
      '<span>格式</span>' +
      head('时长', 'duration') +
      '</div>';
  }

  function trackRowHtml(track, index) {
    var isCurrent = currentTrack() && currentTrack().id === track.id;
    var classes = ['row'];
    if (isCurrent) classes.push('is-current');
    if (state.selectedId === track.id) classes.push('is-selected');
    if (!track.supported) classes.push('is-muted');

    var indexCell = isCurrent && state.playing
      ? '<span class="bars"><i></i><i></i><i></i></span>'
      : String(index + 1);

    var badge = track.supported
      ? '<span class="badge">' + escapeHtml(track.format) + '</span>'
      : '<span class="badge is-unsupported" title="浏览器无法解码此格式">' + escapeHtml(track.format) + '</span>';

    return '<div class="' + classes.join(' ') + '" data-id="' + escapeHtml(track.id) + '" data-index="' + (index + 1) + '">' +
      '<div class="row-index">' + indexCell + '</div>' +
      '<div class="row-main">' +
      '<div class="cover" style="background:' + coverGradient(track.album) + '">' + escapeHtml(track.album.slice(0, 1)) + '</div>' +
      '<div class="row-text"><div class="row-title">' + escapeHtml(track.title) + '</div></div>' +
      '</div>' +
      '<div class="row-artist">' + escapeHtml(track.artist) + '</div>' +
      '<div class="row-album">' + escapeHtml(track.album) + '</div>' +
      '<div>' + badge + '</div>' +
      '<div class="row-dur">' + C.formatTime(track.duration) + '</div>' +
      '</div>';
  }

  function groupsHtml(key) {
    // 搜索关键词同样作用于分组视图，否则在"艺术家 / 专辑"页搜索会毫无反应
    var groups = C.groupBy(C.filterTracks(state.tracks, state.query), key);
    if (!groups.length) return '<div class="empty"><p>暂无内容</p></div>';

    return '<div class="groups">' + groups.map(function (group) {
      var seconds = group.tracks.reduce(function (sum, t) { return sum + t.duration; }, 0);
      return '<button class="group-card" data-group="' + escapeHtml(group.key) + '">' +
        '<div class="group-cover" style="background:' + coverGradient(group.key) + '">' +
        escapeHtml(group.key.slice(0, 1)) + '</div>' +
        '<div class="group-name">' + escapeHtml(group.key) + '</div>' +
        '<div class="group-sub">' + group.tracks.length + ' 首 · ' + C.formatDuration(seconds) + '</div>' +
        '</button>';
    }).join('') + '</div>';
  }

  /** 切歌时只更新行状态，避免重建 DOM 导致滚动位置丢失 */
  function refreshRows() {
    var current = currentTrack();
    Array.prototype.forEach.call(dom.content.querySelectorAll('.row'), function (row) {
      var id = row.dataset.id;
      var isCurrent = !!current && current.id === id;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-selected', state.selectedId === id);

      var cell = row.querySelector('.row-index');
      if (cell) {
        cell.innerHTML = isCurrent && state.playing
          ? '<span class="bars"><i></i><i></i><i></i></span>'
          : (row.dataset.index || '');
      }
    });
  }

  /* ==================== 渲染：播放条 ==================== */

  function renderPlayer() {
    var track = currentTrack();

    if (track) {
      dom.nowCover.style.background = coverGradient(track.album);
      dom.nowCover.innerHTML = '<span>' + escapeHtml(track.album.slice(0, 1)) + '</span>';
      dom.nowTitle.textContent = track.title;
      dom.nowArtist.textContent = track.artist + ' · ' + track.album +
        (track.supported ? '' : ' · ' + track.format.toUpperCase() + ' 不受支持');
    } else {
      dom.nowCover.style.background = '';
      dom.nowCover.innerHTML = '<span>♪</span>';
      dom.nowTitle.textContent = '未在播放';
      dom.nowArtist.textContent = state.imported ? '双击列表中的曲目开始播放' : '请先选择音乐文件夹';
    }

    dom.playIcon.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
    dom.btnPlay.title = state.playing ? '暂停（空格）' : '播放（空格）';

    dom.btnMode.textContent = C.MODE_LABEL[state.mode];
    dom.btnMode.classList.toggle('is-on', state.mode !== 'sequence');

    dom.btnMute.innerHTML = '<svg viewBox="0 0 24 24" class="ico">' +
      (state.muted || state.volume === 0 ? VOL_OFF : VOL_ON) + '</svg>';
    dom.volume.value = String(Math.round(state.volume * 100));

    renderProgress();
  }

  function renderProgress() {
    var track = currentTrack();
    var duration = track ? track.duration : 0;
    var ratio = duration ? clamp(state.progress / duration, 0, 1) : 0;

    dom.progressFill.style.width = (ratio * 100) + '%';
    dom.progressKnob.style.left = (ratio * 100) + '%';
    dom.tNow.textContent = C.formatTime(state.progress);
    dom.tTotal.textContent = C.formatTime(duration);
  }

  /* ==================== 渲染：队列抽屉 ==================== */

  function renderQueue() {
    if (!state.queue.length) {
      dom.drawerBody.innerHTML =
        '<div class="empty" style="margin-top:40px"><p style="font-size:13px">队列为空<br>双击曲目即可建立播放队列</p></div>';
      dom.btnClearQueue.disabled = true;
      return;
    }

    dom.btnClearQueue.disabled = false;
    dom.drawerBody.innerHTML = state.queue.map(function (id, index) {
      var track = trackMap[id];
      if (!track) return '';
      var classes = 'queue-item' + (index === state.currentIndex ? ' is-current' : '');
      return '<div class="' + classes + '" data-qindex="' + index + '">' +
        '<div class="q-idx">' + (index === state.currentIndex && state.playing ? '▶' : (index + 1)) + '</div>' +
        '<div class="q-text">' +
        '<div class="q-title">' + escapeHtml(track.title) + '</div>' +
        '<div class="q-sub">' + escapeHtml(track.artist) +
        (track.supported ? '' : ' · ' + track.format.toUpperCase()) + '</div>' +
        '</div>' +
        '<button class="q-del" data-qdel="' + index + '" title="从队列移除">✕</button>' +
        '</div>';
    }).join('');
  }

  /* ==================== 总渲染 ==================== */

  function renderAll() {
    renderSidebar();
    renderToolbar();
    renderContent();
    renderPlayer();
    renderQueue();
  }

  /* ==================== 播放控制 ==================== */

  function selectTrack(id) {
    state.selectedId = id;
    refreshRows();
  }

  /** 从当前可见列表建立队列并播放指定曲目 */
  function playFromVisible(id) {
    var list = visibleTracks();
    var queue = C.buildQueue(list);
    var index = queue.indexOf(id);
    if (index === -1) return;

    state.queue = queue;
    state.selectedId = id;
    state.currentIndex = index;
    state.progress = 0;
    if (state.mode === 'shuffle') reshuffle(index);

    var track = trackAt(index);
    if (track && !track.supported) {
      state.playing = false;
      toast('「' + track.title + '」是 ' + track.format.toUpperCase() + ' 格式，浏览器无法解码，正在跳到下一首可播放的曲目', true);
      renderAll();
      advance(false);
      return;
    }

    state.playing = true;
    renderAll();
    save();
  }

  function togglePlay() {
    if (!state.queue.length) {
      var list = visibleTracks();
      if (list.length) playFromVisible(list[0].id);
      return;
    }
    if (state.currentIndex < 0) {
      state.currentIndex = 0;
    }
    var track = currentTrack();
    if (track && !track.supported) {
      advance(false);
      return;
    }
    state.playing = !state.playing;
    renderPlayer();
    refreshRows();
    renderQueue();
    save();
  }

  function gotoIndex(index, playing) {
    state.currentIndex = index;
    state.progress = 0;
    state.playing = playing !== false;
    state.selectedId = state.queue[index] || null;
    renderPlayer();
    refreshRows();
    renderQueue();
    save();
  }

  function stopAtEnd(message) {
    state.playing = false;
    state.progress = 0;
    toast(message || '已播放到列表末尾');
    renderPlayer();
    refreshRows();
    renderQueue();
    save();
  }

  /**
   * 前进或后退一首。
   * 会自动跳过浏览器无法解码的格式，并提示跳过了几首。
   */
  function advance(auto, direction) {
    var length = state.queue.length;
    if (!length || state.currentIndex < 0) return;

    var dir = direction === 'prev' ? 'prev' : 'next';
    var cursor = state.currentIndex;
    var skipped = 0;
    var isAuto = !!auto;

    for (var step = 0; step < length + 1; step++) {
      // 单曲循环在"跳过不可解码曲目"时会原地打转，此时临时按列表循环前进
      var mode = (skipped > 0 && state.mode === 'repeat-one') ? 'repeat-all' : state.mode;

      var next = dir === 'prev'
        ? C.resolvePrevIndex({ mode: mode, currentIndex: cursor, queueLength: length, order: state.order })
        : C.resolveNextIndex({ mode: mode, currentIndex: cursor, queueLength: length, order: state.order, auto: isAuto });

      if (next === -1) {
        stopAtEnd();
        return;
      }

      var track = trackAt(next);
      if (track && track.supported) {
        if (skipped > 0) {
          toast('已跳过 ' + skipped + ' 首无法解码的曲目', true);
        }
        gotoIndex(next, true);
        return;
      }

      skipped += 1;
      cursor = next;
      isAuto = true;

      if (cursor === state.currentIndex) break;  // 绕回起点，说明整个队列都不可播放
    }

    stopAtEnd(skipped > 0 ? '队列中没有可播放的曲目' : '已播放到列表末尾');
  }

  function nudge(delta) {
    var track = currentTrack();
    if (!track) return;
    state.progress = clamp(state.progress + delta, 0, track.duration);
    renderProgress();
  }

  function seekToRatio(ratio) {
    var track = currentTrack();
    if (!track) return;
    state.progress = clamp(track.duration * ratio, 0, track.duration);
    renderProgress();
  }

  /* ==================== 播放推进（模拟） ==================== */

  function startTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      if (!state.playing) return;
      var track = currentTrack();
      if (!track) return;

      state.progress += state.speed;

      if (state.progress >= track.duration) {
        state.progress = track.duration;
        renderProgress();
        advance(true);
        return;
      }

      renderProgress();
      if (Math.floor(state.progress) % 5 === 0) save();
    }, 1000);
  }

  /* ==================== 弹窗与扫描 ==================== */

  function openFolderModal() {
    dom.pickStep.hidden = false;
    dom.scanStep.hidden = true;
    dom.scanFill.style.width = '0%';
    dom.scanCount.textContent = '0 / 24';
    dom.scanWarn.textContent = '';
    dom.folderModal.hidden = false;
  }

  function closeFolderModal() {
    dom.folderModal.hidden = true;
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  var MOCK_DIRS = ['夏日回声', '雨落青瓦', '远方来信', '午后三点', '深海备忘录', '晨光练习曲'];
  var MOCK_FILES = [
    ['readme.txt', 'txt'],
    ['cover.jpg', 'jpg'],
    ['playlist.m3u', 'm3u']
  ];

  function renderFileList() {
    dom.crumb.innerHTML = '此电脑 <b>›</b> 音乐 <b>›</b> ' + escapeHtml(FOLDER.name);

    var html = MOCK_DIRS.map(function (name) {
      return '<div class="file-item is-dir">' +
        '<svg viewBox="0 0 24 24" class="ico"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>' +
        '<span>' + escapeHtml(name) + '</span></div>';
    }).join('');

    html += MOCK_FILES.map(function (item) {
      return '<div class="file-item is-file">' +
        '<svg viewBox="0 0 24 24" class="ico"><path d="M6 2h8l6 6v14H6z" opacity="0.55"/></svg>' +
        '<span>' + escapeHtml(item[0]) + '</span>' +
        '<span class="badge">' + escapeHtml(item[1]) + '</span></div>';
    }).join('');

    dom.fileList.innerHTML = html;
  }

  function startScan() {
    dom.pickStep.hidden = true;
    dom.scanStep.hidden = false;

    var all = C.createMockLibrary();
    var cursor = 0;
    var total = all.length;

    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(function () {
      if (cursor >= total) {
        clearInterval(scanTimer);
        scanTimer = null;
        finishImport(all);
        return;
      }

      var track = all[cursor];
      cursor += 1;

      dom.scanFile.textContent = FOLDER.name + '/' + track.album + '/' +
        String(track.trackNo).padStart(2, '0') + ' ' + track.title + '.' + track.format;
      dom.scanFill.style.width = (cursor / total * 100).toFixed(1) + '%';
      dom.scanCount.textContent = cursor + ' / ' + total;

      var unsupported = all.slice(0, cursor).filter(function (t) { return !t.supported; }).length;
      dom.scanWarn.textContent = unsupported ? unsupported + ' 个文件格式不受支持' : '';
    }, SCAN_INTERVAL);
  }

  function finishImport(tracks) {
    state.tracks = tracks;
    state.imported = true;
    state.folderName = FOLDER.name;
    trackMap = indexTracks(tracks);

    state.queue = [];
    state.order = [];
    state.currentIndex = -1;
    state.progress = 0;
    state.playing = false;
    state.selectedId = null;

    closeFolderModal();

    var summary = C.summarizeLibrary(tracks);
    toast('已导入 ' + summary.total + ' 首曲目' +
      (summary.unsupported ? '，其中 ' + summary.unsupported + ' 首格式不受支持' : ''));

    renderAll();
    save();
  }

  /* ==================== 提示 ==================== */

  function toast(message, isWarn) {
    var node = document.createElement('div');
    node.className = 'toast' + (isWarn ? ' is-warn' : '');
    node.textContent = message;
    dom.toasts.appendChild(node);

    while (dom.toasts.children.length > 3) {
      dom.toasts.removeChild(dom.toasts.firstChild);
    }

    setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () { node.remove(); }, 320);
    }, 2400);
  }

  /* ==================== 抽屉 ==================== */

  function openDrawer() {
    dom.drawer.classList.add('is-open');
    dom.drawer.setAttribute('aria-hidden', 'false');
    dom.drawerBackdrop.hidden = false;
  }

  function closeDrawer() {
    dom.drawer.classList.remove('is-open');
    dom.drawer.setAttribute('aria-hidden', 'true');
    dom.drawerBackdrop.hidden = true;
  }

  function removeFromQueue(index) {
    if (index < 0 || index >= state.queue.length) return;

    state.queue.splice(index, 1);

    if (index < state.currentIndex) {
      state.currentIndex -= 1;
    } else if (index === state.currentIndex) {
      state.playing = false;
      state.progress = 0;
      if (state.currentIndex >= state.queue.length) state.currentIndex = state.queue.length - 1;
    }

    if (!state.queue.length) {
      state.currentIndex = -1;
      state.playing = false;
    }

    if (state.mode === 'shuffle') reshuffle(state.currentIndex);
    else state.order = C.shuffleOrder(state.queue.length);

    renderPlayer();
    refreshRows();
    renderQueue();
    save();
  }

  /* ==================== 事件绑定 ==================== */

  function bindEvents() {
    // ---- 侧栏 ----
    dom.btnPick.addEventListener('click', openFolderModal);
    dom.btnReset.addEventListener('click', resetDemo);

    dom.nav.addEventListener('click', function (e) {
      var item = e.target.closest('.nav-item');
      if (!item) return;
      state.view = item.dataset.view;
      renderToolbar();
      renderContent();
      renderSidebar();
    });

    // ---- 顶栏 ----
    dom.search.addEventListener('input', function () {
      state.query = dom.search.value;
      renderToolbar();
      renderContent();
    });

    dom.sortKey.addEventListener('change', function () {
      state.sortKey = dom.sortKey.value;
      renderToolbar();
      renderContent();
      save();
    });

    dom.btnSortDir.addEventListener('click', function () {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      renderToolbar();
      renderContent();
      save();
    });

    dom.btnPlayAll.addEventListener('click', function () {
      var list = visibleTracks();
      if (list.length) playFromVisible(list[0].id);
    });

    // ---- 列表交互 ----
    dom.content.addEventListener('click', function (e) {
      if (e.target.id === 'emptyPick') {
        openFolderModal();
        return;
      }

      var head = e.target.closest('[data-sort]');
      if (head) {
        var key = head.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDir = 'asc';
        }
        renderToolbar();
        renderContent();
        save();
        return;
      }

      var card = e.target.closest('.group-card');
      if (card) {
        state.view = 'all';
        state.query = card.dataset.group;
        dom.search.value = state.query;
        renderSidebar();
        renderToolbar();
        renderContent();
        return;
      }

      var row = e.target.closest('.row');
      if (row) selectTrack(row.dataset.id);
    });

    dom.content.addEventListener('dblclick', function (e) {
      var row = e.target.closest('.row');
      if (row) playFromVisible(row.dataset.id);
    });

    // ---- 播放控制 ----
    dom.btnPlay.addEventListener('click', togglePlay);
    dom.btnNext.addEventListener('click', function () { advance(false, 'next'); });
    dom.btnPrev.addEventListener('click', function () { advance(false, 'prev'); });

    dom.btnMode.addEventListener('click', function () {
      state.mode = C.nextMode(state.mode);
      if (state.mode === 'shuffle') reshuffle(state.currentIndex);
      renderPlayer();
      toast('播放模式：' + C.MODE_LABEL[state.mode] +
        (state.mode === 'shuffle' ? '（已重新洗牌，避免连续重复）' : ''));
      save();
    });

    dom.btnMute.addEventListener('click', function () {
      state.muted = !state.muted;
      renderPlayer();
      save();
    });

    dom.volume.addEventListener('input', function () {
      state.volume = clamp(Number(dom.volume.value) / 100, 0, 1);
      if (state.volume > 0) state.muted = false;
      dom.btnMute.innerHTML = '<svg viewBox="0 0 24 24" class="ico">' +
        (state.muted || state.volume === 0 ? VOL_OFF : VOL_ON) + '</svg>';
      save();
    });

    dom.btnSpeed.addEventListener('click', function () {
      state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
      state.speed = SPEEDS[state.speedIndex];
      dom.btnSpeed.textContent = '×' + state.speed;
      dom.btnSpeed.classList.toggle('is-on', state.speed > 1);
      toast('演示推进速度 ×' + state.speed + (state.speed > 1 ? '，便于观察自动切歌' : ''));
    });

    // ---- 进度条拖动 ----
    dom.progress.addEventListener('pointerdown', function (e) {
      if (!currentTrack()) return;
      dom.progress.classList.add('is-dragging');
      try { dom.progress.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      seekToRatio(ratioFromEvent(e));
    });

    dom.progress.addEventListener('pointermove', function (e) {
      if (dom.progress.classList.contains('is-dragging')) seekToRatio(ratioFromEvent(e));
    });

    dom.progress.addEventListener('pointerup', function (e) {
      dom.progress.classList.remove('is-dragging');
      try { dom.progress.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      save();
    });

    // ---- 队列抽屉 ----
    dom.btnDrawer.addEventListener('click', function () {
      if (dom.drawer.classList.contains('is-open')) closeDrawer();
      else openDrawer();
    });
    dom.btnCloseDrawer.addEventListener('click', closeDrawer);
    dom.drawerBackdrop.addEventListener('click', closeDrawer);

    dom.drawerBody.addEventListener('click', function (e) {
      var del = e.target.closest('[data-qdel]');
      if (del) {
        removeFromQueue(Number(del.dataset.qdel));
        return;
      }
      var item = e.target.closest('.queue-item');
      if (item) {
        var index = Number(item.dataset.qindex);
        var track = trackAt(index);
        if (track && !track.supported) {
          toast('「' + track.title + '」是 ' + track.format.toUpperCase() + ' 格式，浏览器无法解码', true);
          return;
        }
        gotoIndex(index, true);
      }
    });

    dom.btnClearQueue.addEventListener('click', function () {
      state.queue = [];
      state.order = [];
      state.currentIndex = -1;
      state.progress = 0;
      state.playing = false;
      renderPlayer();
      refreshRows();
      renderQueue();
      toast('已清空播放队列');
      save();
    });

    // ---- 弹窗 ----
    dom.btnPickCancel.addEventListener('click', closeFolderModal);
    dom.btnPickConfirm.addEventListener('click', startScan);
    dom.folderModal.addEventListener('click', function (e) {
      if (e.target === dom.folderModal) closeFolderModal();
    });

    // ---- 键盘 ----
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nudge(5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        nudge(-5);
      } else if (e.key === 'Escape') {
        if (!dom.folderModal.hidden) closeFolderModal();
        else if (dom.drawer.classList.contains('is-open')) closeDrawer();
      }
    });
  }

  function ratioFromEvent(e) {
    var rect = dom.progress.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  }

  /* ==================== 重置 ==================== */

  function resetDemo() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* 忽略 */ }

    state = createInitialState();
    trackMap = {};
    dom.search.value = '';
    dom.btnSpeed.textContent = '×1';
    dom.btnSpeed.classList.remove('is-on');
    closeDrawer();
    renderAll();
    toast('演示已重置，可从空曲库重新开始');
  }

  /* ==================== 启动 ==================== */

  function initSortOptions() {
    dom.sortKey.innerHTML = C.SORT_KEYS.map(function (key) {
      return '<option value="' + key + '">' + C.SORT_LABEL[key] + '</option>';
    }).join('');
  }

  function init() {
    initSortOptions();
    renderFileList();
    restore();
    bindEvents();
    renderAll();
    startTick();

    if (state.imported) {
      toast('已从本地缓存恢复曲库与上次播放位置');
    }
  }

  init();
})();
