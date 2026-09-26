/*!
 * 轻音播放 · 纯逻辑模块 (core.js)
 *
 * 设计约束（对应产品技术文档 5.2 节）：
 *   - 不引用任何浏览器 API，不做 DOM 操作，不做 I/O，无副作用
 *   - 因此可同时被浏览器（挂载为全局 LiteCore）与 Node 测试（require）加载
 *
 * UMD 包装是为了让 file:// 直接打开 index.html 时无需 ES module（避免跨源限制）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiteCore = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ==================== 常量 ==================== */

  var MODES = ['sequence', 'repeat-all', 'repeat-one', 'shuffle'];

  var MODE_LABEL = {
    sequence: '顺序播放',
    'repeat-all': '列表循环',
    'repeat-one': '单曲循环',
    shuffle: '随机播放'
  };

  var SUPPORTED_FORMATS = ['mp3', 'flac', 'm4a', 'ogg', 'wav'];

  var SORT_KEYS = ['default', 'title', 'artist', 'album', 'duration'];

  var SORT_LABEL = {
    default: '默认排序',
    title: '按标题',
    artist: '按艺术家',
    album: '按专辑',
    duration: '按时长'
  };

  /* ==================== 文本与时间（含中文排序） ==================== */

  var collator = null;
  try {
    collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch (err) {
    collator = null;
  }

  function compareText(a, b) {
    var x = a == null ? '' : String(a);
    var y = b == null ? '' : String(b);
    if (collator) return collator.compare(x, y);
    return x.localeCompare(y);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 秒 -> "3:45" / "1:02:05"；非法输入一律归零 */
  function formatTime(seconds) {
    var total = Math.floor(Number(seconds));
    if (!isFinite(total) || total < 0) total = 0;
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  /** 秒 -> "3 小时 12 分" / "48 分钟"，用于曲库统计 */
  function formatDuration(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    return m + ' 分钟';
  }

  /** 时间戳 -> "2026/01/01" */
  function formatDate(timestamp) {
    var d = new Date(Number(timestamp));
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  }

  /* ==================== 格式与模式 ==================== */

  function isSupportedFormat(ext) {
    return SUPPORTED_FORMATS.indexOf(String(ext == null ? '' : ext).toLowerCase()) !== -1;
  }

  function nextMode(mode) {
    var i = MODES.indexOf(mode);
    return MODES[(i + 1) % MODES.length];
  }

  function isValidMode(mode) {
    return MODES.indexOf(mode) !== -1;
  }

  /* ==================== 检索与排序 ==================== */

  function normalize(value) {
    return String(value == null ? '' : value).toLowerCase();
  }

  function filterTracks(tracks, query) {
    var q = normalize(query).trim();
    if (!q) return tracks.slice();
    return tracks.filter(function (t) {
      return normalize(t.title).indexOf(q) !== -1 ||
        normalize(t.artist).indexOf(q) !== -1 ||
        normalize(t.album).indexOf(q) !== -1;
    });
  }

  function sortTracks(tracks, key, direction) {
    var list = tracks.slice();
    if (!key || key === 'default') return list;
    var sign = direction === 'desc' ? -1 : 1;
    list.sort(function (a, b) {
      var r;
      if (key === 'duration') {
        r = (a.duration || 0) - (b.duration || 0);
      } else {
        r = compareText(a[key], b[key]);
      }
      if (r === 0) r = compareText(a.title, b.title);
      return r * sign;
    });
    return list;
  }

  function groupBy(tracks, key) {
    var buckets = {};
    var keys = [];
    tracks.forEach(function (t) {
      var k = t[key] || '未知';
      if (!buckets[k]) {
        buckets[k] = [];
        keys.push(k);
      }
      buckets[k].push(t);
    });
    keys.sort(compareText);
    return keys.map(function (k) {
      return { key: k, tracks: buckets[k] };
    });
  }

  /* ==================== 队列与洗牌 ==================== */

  function range(n) {
    var arr = [];
    for (var i = 0; i < n; i++) arr.push(i);
    return arr;
  }

  function validOrder(order, length) {
    return Array.isArray(order) && order.length === length;
  }

  /**
   * Fisher-Yates 洗牌，返回下标序列。
   * 强调"洗牌"而非"每次随机取一首"，避免同一首被连续重复播放。
   * rng 可注入，便于测试确定性。
   */
  function shuffleOrder(length, rng) {
    var random = typeof rng === 'function' ? rng : Math.random;
    var arr = range(length);
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** 由曲目列表构建播放队列（存 id，避免视图过滤影响播放） */
  function buildQueue(tracks) {
    return tracks.map(function (t) {
      return t.id;
    });
  }

  /**
   * 计算下一首在队列中的下标。
   *
   * @param {object} options
   * @param {string}  options.mode         播放模式
   * @param {number}  options.currentIndex 当前下标
   * @param {number}  options.queueLength  队列长度
   * @param {number[]} [options.order]     随机模式的洗牌序列
   * @param {boolean} [options.auto]       是否由"自然播放结束"触发
   * @returns {number} 下一首下标；-1 表示播放结束
   */
  function resolveNextIndex(options) {
    var o = options || {};
    var len = o.queueLength || 0;
    var cur = typeof o.currentIndex === 'number' ? o.currentIndex : -1;
    var auto = !!o.auto;

    if (len <= 0) return -1;
    if (cur < 0) return 0;

    if (o.mode === 'repeat-one') {
      // 自然结束时重复本首；手动点"下一首"仍按列表循环前进
      return auto ? cur : (cur + 1) % len;
    }

    if (o.mode === 'shuffle') {
      var seq = validOrder(o.order, len) ? o.order : range(len);
      var pos = seq.indexOf(cur);
      if (pos === -1) pos = 0;
      var nextPos = pos + 1;
      return nextPos >= len ? seq[0] : seq[nextPos];
    }

    if (o.mode === 'repeat-all') {
      return (cur + 1) % len;
    }

    // sequence：顺序播放到末尾即停止
    var next = cur + 1;
    return next >= len ? -1 : next;
  }

  /**
   * 计算上一首在队列中的下标。
   * 顺序模式下停在第一首；其余模式从队首回到队尾（符合常见播放器直觉）。
   */
  function resolvePrevIndex(options) {
    var o = options || {};
    var len = o.queueLength || 0;
    var cur = typeof o.currentIndex === 'number' ? o.currentIndex : -1;

    if (len <= 0) return -1;
    if (cur < 0) return 0;

    if (o.mode === 'shuffle' && validOrder(o.order, len)) {
      var pos = o.order.indexOf(cur);
      if (pos > 0) return o.order[pos - 1];
      return o.order[len - 1];
    }

    if (cur === 0) {
      return o.mode === 'sequence' ? 0 : len - 1;
    }
    return cur - 1;
  }

  /* ==================== 曲库统计 ==================== */

  function summarizeLibrary(tracks) {
    var duration = 0;
    var unsupported = 0;
    var artists = {};
    var albums = {};

    tracks.forEach(function (t) {
      duration += t.duration || 0;
      if (t.supported === false) unsupported += 1;
      if (t.artist) artists[t.artist] = true;
      if (t.album) albums[t.album] = true;
    });

    return {
      total: tracks.length,
      duration: duration,
      unsupported: unsupported,
      artistCount: Object.keys(artists).length,
      albumCount: Object.keys(albums).length
    };
  }

  /* ==================== 模拟数据 ==================== */
  /* demo 专用：真实版本将由元数据解析结果填充，字段结构保持一致。 */

  var MOCK_ALBUMS = [
    {
      album: '夏日回声', artist: '林间清响', year: 2021, tracks: [
        ['蝉鸣渐起', 222, 'mp3'],
        ['汽水与晚风', 245, 'flac'],
        ['天台上的云', 198, 'mp3'],
        ['旧单车', 272, 'flac'],
        ['夏天没有结束', 235, 'm4a'],
        ['回声', 168, 'mp3']
      ]
    },
    {
      album: '雨落青瓦', artist: '林间清响', year: 2022, tracks: [
        ['瓦上雨', 260, 'flac'],
        ['巷口', 216, 'mp3'],
        ['湿漉漉的黄昏', 298, 'flac'],
        ['一盏灯', 192, 'mp3']
      ]
    },
    {
      album: '远方来信', artist: '雾岛听风', year: 2020, tracks: [
        ['寄往北方的信', 302, 'flac'],
        ['车站', 224, 'mp3'],
        ['沿途', 266, 'ape'],
        ['潮汐线', 251, 'flac'],
        ['未寄出的一页', 209, 'mp3']
      ]
    },
    {
      album: '午后三点', artist: '纸飞机乐队', year: 2023, tracks: [
        ['三点零七分', 201, 'mp3'],
        ['打盹', 177, 'mp3'],
        ['玻璃窗上的光斑', 243, 'flac'],
        ['慢下来', 218, 'm4a']
      ]
    },
    {
      album: '深海备忘录', artist: '雾岛听风', year: 2024, tracks: [
        ['水压', 287, 'ape'],
        ['蓝', 312, 'flac'],
        ['浮标', 213, 'mp3']
      ]
    },
    {
      album: '晨光练习曲', artist: '苏晚晴', year: 2025, tracks: [
        ['晨光', 161, 'wav'],
        ['练习曲第一号', 185, 'ape']
      ]
    }
  ];

  var MOCK_BASE_TIME = Date.UTC(2026, 0, 20, 10, 0, 0);
  var DAY = 86400000;

  function createMockLibrary() {
    var list = [];
    var seq = 0;

    MOCK_ALBUMS.forEach(function (album, albumIndex) {
      album.tracks.forEach(function (item, trackIndex) {
        seq += 1;
        var title = item[0];
        var duration = item[1];
        var format = item[2];
        var id = 't' + pad2(seq);

        list.push({
          id: id,
          title: title,
          artist: album.artist,
          album: album.album,
          albumIndex: albumIndex,
          trackNo: trackIndex + 1,
          year: album.year,
          duration: duration,
          format: format,
          supported: isSupportedFormat(format),
          path: '/音乐/轻音收藏/' + album.album + '/' + pad2(trackIndex + 1) + ' ' + title + '.' + format,
          // 越靠前越"新"，用于"最近添加"视图
          addedAt: MOCK_BASE_TIME - (seq - 1) * DAY
        });
      });
    });

    return list;
  }

  /* ==================== 导出 ==================== */

  return {
    // 常量
    MODES: MODES,
    MODE_LABEL: MODE_LABEL,
    SORT_KEYS: SORT_KEYS,
    SORT_LABEL: SORT_LABEL,
    SUPPORTED_FORMATS: SUPPORTED_FORMATS,

    // 文本与时间
    compareText: compareText,
    formatTime: formatTime,
    formatDuration: formatDuration,
    formatDate: formatDate,

    // 格式与模式
    isSupportedFormat: isSupportedFormat,
    nextMode: nextMode,
    isValidMode: isValidMode,

    // 检索与排序
    filterTracks: filterTracks,
    sortTracks: sortTracks,
    groupBy: groupBy,

    // 队列与洗牌
    range: range,
    shuffleOrder: shuffleOrder,
    buildQueue: buildQueue,
    resolveNextIndex: resolveNextIndex,
    resolvePrevIndex: resolvePrevIndex,

    // 统计与模拟数据
    summarizeLibrary: summarizeLibrary,
    createMockLibrary: createMockLibrary
  };
});
