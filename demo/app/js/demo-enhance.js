/*!
 * demo-enhance.js —— 演示页增强（数据看板动画 + 分步操作引导）
 * 纯前端、零依赖，不改动任何业务脚本。
 *  - 数据看板：统计数字滚动、7 日柱状图生长、卡片依次入场
 *  - 操作引导：右下角悬浮按钮，分步高亮 + 气泡讲解，可上一步/下一步/跳过
 */
(function () {
  'use strict';

  /* ==================== Part 1：数据看板动画 ==================== */
  (function dashboardAnim() {
    var stats = document.querySelector('.stats');
    if (!stats) return; // 仅管理端含看板

    var css = [
      '@keyframes dkStatIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
      '@keyframes dkPop{0%{transform:scale(1)}40%{transform:scale(1.06)}100%{transform:scale(1)}}',
      '@keyframes dkSparkIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
      '.stats .stat{animation:dkStatIn .55s both}',
      '.stats .stat:nth-child(1){animation-delay:.05s}',
      '.stats .stat:nth-child(2){animation-delay:.12s}',
      '.stats .stat:nth-child(3){animation-delay:.19s}',
      '.stats .stat:nth-child(4){animation-delay:.26s}',
      '.chart-card{animation:dkStatIn .6s .3s both}',
      '.spark-col{animation:dkSparkIn .5s both}',
      '.spark-col:nth-child(1){animation-delay:.30s}.spark-col:nth-child(2){animation-delay:.36s}',
      '.spark-col:nth-child(3){animation-delay:.42s}.spark-col:nth-child(4){animation-delay:.48s}',
      '.spark-col:nth-child(5){animation-delay:.54s}.spark-col:nth-child(6){animation-delay:.60s}',
      '.spark-col:nth-child(7){animation-delay:.66s}.spark-col:nth-child(8){animation-delay:.72s}'
    ].join('\n');
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    // 数字滚动
    function countUp(el, to) {
      if (el.__dkAnimating) return;
      el.__dkAnimating = true;
      var start = null, dur = 900;
      function step(ts) {
        if (start === null) start = ts;
        var p = Math.min(1, (ts - start) / dur);
        var ease = 1 - Math.pow(1 - p, 3);
        var val = Math.round(to * ease);
        el.innerHTML = val + '<span class="u">次</span>';
        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          el.innerHTML = to + '<span class="u">次</span>';
          el.style.animation = 'none';
          void el.offsetWidth;
          el.style.animation = 'dkPop .45s ease';
          el.__dkAnimating = false;
        }
      }
      requestAnimationFrame(step);
    }

    Array.prototype.forEach.call(document.querySelectorAll('.stats .v'), function (v) {
      v.__dkLast = null;
      var mo = new MutationObserver(function () {
        var to = parseInt((v.textContent || '').replace(/次/g, ''), 10);
        if (!isFinite(to) || v.__dkAnimating || to === v.__dkLast) return;
        v.__dkLast = to;
        countUp(v, to);
      });
      mo.observe(v, { childList: true, characterData: true, subtree: true });
    });

    // 柱状图生长
    var trend = document.getElementById('trend');
    if (trend) {
      var tmo = new MutationObserver(function () {
        var bars = trend.querySelectorAll('.spark-bar > i');
        if (!bars.length) return;
        Array.prototype.forEach.call(bars, function (b, i) {
          if (b.dataset.dkAnimated) return;
          b.dataset.dkAnimated = '1';
          var target = b.style.height || '0%';
          b.style.transition = 'none';
          b.style.height = '0%';
          void b.offsetHeight;
          setTimeout(function () {
            b.style.transition = 'height .75s cubic-bezier(.22,.85,.3,1) ' + (i * 70) + 'ms';
            b.style.height = target;
          }, 40);
        });
      });
      tmo.observe(trend, { childList: true, subtree: true });
    }
  })();

  /* ==================== Part 2：分步操作引导 ==================== */
  (function guide() {
    var path = location.pathname;
    var inApp = path.indexOf('/app/') >= 0;
    var file = (path.split('/').pop() || 'index.html').toLowerCase();
    var key = (!inApp && path.indexOf('/demo/') >= 0) ? 'home' : file;

    function first(sels) {
      for (var i = 0; i < sels.length; i++) {
        var e = document.querySelector(sels[i]);
        if (e) return e;
      }
      return null;
    }

    var STEPS = {
      home: [
        { sel: ['.role-btn'], t: '① 选择演示身份', d: '先选「现场人员」或「管理员」。身份只影响入口推荐，演示无需密码，任意账号均可体验。' },
        { sel: ['a[href$="app/index.html"]'], t: '② 现场打卡', d: '进入打卡页：选机房 → 拍照自动加水印 → 勾选巡检项 → 提交，完整走一遍现场流程。' },
        { sel: ['a[href$="app/admin.html"]'], t: '③ 管理端看板', d: '管理端有动态数字看板和 7 日柱状趋势，还有记录筛选、用户/机房/水印配置。' },
        { sel: ['a[href$="app/rack-topology.html"]'], t: '④ 机柜拓扑', d: '拓扑编辑器支持拖拽机柜、端口连线、多机房切换，修改自动保存在本机浏览器。' }
      ],
      'index.html': [
        { sel: ['#roomSel', '#room', 'select'], t: '① 选择机房', d: '打卡前先选本次巡检的机房，系统会记住上次选择。' },
        { sel: ['#photoBtn', '.photo-btn', 'input[type=file]', 'label[for]'], t: '② 拍照加水印', d: '拍照或从相册选图，照片自动叠加时间/机房水印并压缩上传。' },
        { sel: ['#noteInput', '#note', 'textarea'], t: '③ 填写巡检说明', d: '可填写备注与巡检项结果，异常项会标红提示，便于管理端筛查。' },
        { sel: ['#submitBtn', 'button[type=submit]', '.submit-btn'], t: '④ 提交打卡', d: '确认定位与照片后提交，即完成一次现场打卡。数据只存在本机浏览器。' }
      ],
      'records.html': [
        { sel: ['input[type=text]', '#kw', '#fKw'], t: '① 搜索记录', d: '按姓名、机房、备注关键词搜索，支持日期区间筛选。' },
        { sel: ['canvas', '.trend', '#trend', '.chart'], t: '② 趋势统计', d: '这里展示打卡趋势与异常分布，帮助你快速掌握一段时间的情况。' },
        { sel: ['#exportBtn', 'button[id*=export]', 'button[id*=Export]'], t: '③ 导出明细', d: '可导出 Excel（照片内嵌）或 HTML 报表，演示模式下生成的是模拟文件。' }
      ],
      'admin.html': [
        { sel: ['.stats'], t: '① 数据看板', d: '今日/本月打卡与异常数会动态滚动展示，数字变化一目了然。' },
        { sel: ['#trend', '.chart-card'], t: '② 打卡强度趋势', d: '近 7 日柱状图逐根生长：柱高为当日次数，红色段代表异常记录。' },
        { sel: ['#searchBtn', '.filter-grid'], t: '③ 记录筛选', d: '按关键字、日期筛选，勾选「只看异常」可快速定位问题记录。' },
        { sel: ['#tabs button[data-tab=cfg]', '.seg-tabs button'], t: '④ 系统配置', d: '切到「系统配置」可管理用户、机房、巡检模板与水印模板。' }
      ],
      'rack-topology.html': [
        { sel: ['.role-btn', '#roomSel', 'select'], t: '① 多机房切换', d: '顶部「机房」下拉可切换、新建、复制多份机房拓扑。' },
        { sel: ['canvas', '#canvas', '.canvas-wrap'], t: '② 编辑画布', d: '拖拽机柜调整位置，点击空位添加机柜，右键菜单可登记 U 位与端口。' },
        { sel: ['.toolbar', '#topoBar', '.topbar'], t: '③ 连线与保存', d: '从机柜端口拖出连线即可绕行布线；修改自动保存，演示模式仅存本机。' }
      ],
      'login.html': [
        { sel: ['input[type=text]', 'input[name=username]'], t: '① 输入账号', d: '演示模式下任意账号均可登录，无需真实密码校验。' },
        { sel: ['button[type=submit]', '.submit-btn', 'button'], t: '② 登录体验', d: '点击登录即可进入对应端。此页仅作界面演示，不影响本机数据。' }
      ],
      'change-password.html': [
        { sel: ['input[type=password]'], t: '① 修改密码', d: '演示模式下改密不落库，仅展示交互流程，放心输入。' }
      ]
    };

    var steps = STEPS[key] || STEPS['index.html'];
    if (!steps || !steps.length) return;

    // 构建 DOM
    var mask = document.createElement('div');
    var spot = document.createElement('div');
    var tip = document.createElement('div');
    var btn = document.createElement('button');
    mask.className = 'dk-mask';
    spot.className = 'dk-spot';
    tip.className = 'dk-tip';
    btn.type = 'button';
    btn.className = 'dk-guide-btn';
    btn.innerHTML = '🎯 操作引导';
    btn.title = '查看本页操作引导';

    var style = document.createElement('style');
    style.textContent = [
      '.dk-guide-btn{position:fixed;right:18px;bottom:22px;z-index:9997;border:none;cursor:pointer;',
      'background:linear-gradient(135deg,#1f6feb,#1a7f37);color:#fff;font:600 13px/1 -apple-system,"Microsoft YaHei",sans-serif;',
      'padding:12px 17px;border-radius:26px;box-shadow:0 6px 20px rgba(31,111,235,.4);animation:dkPulse 2.4s infinite}',
      '.dk-guide-btn:hover{filter:brightness(1.08)}',
      '@keyframes dkPulse{0%,100%{box-shadow:0 6px 20px rgba(31,111,235,.4)}50%{box-shadow:0 6px 26px rgba(31,111,235,.75)}}',
      '.dk-mask{position:fixed;inset:0;z-index:9998;background:transparent}',
      '.dk-spot{position:fixed;z-index:9999;border:2px solid #4c9aff;border-radius:10px;pointer-events:none;',
      'box-shadow:0 0 0 9999px rgba(8,20,40,.62),0 0 0 4px rgba(76,154,255,.25);transition:all .28s ease}',
      '.dk-tip{position:fixed;z-index:10000;max-width:330px;background:#fff;color:#1f2933;border-radius:12px;',
      'padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.35);font:14px/1.65 -apple-system,"Microsoft YaHei",sans-serif;transition:all .28s ease}',
      '.dk-tip .dk-t{font-weight:700;font-size:15px;margin-bottom:6px;color:#1f6feb}',
      '.dk-tip .dk-d{color:#5b6b7b}',
      '.dk-tip .dk-bar{display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:8px}',
      '.dk-tip .dk-dots{display:flex;gap:5px}.dk-tip .dk-dots i{width:7px;height:7px;border-radius:50%;background:#d5dce5;transition:.2s}',
      '.dk-tip .dk-dots i.on{background:#1f6feb;width:18px;border-radius:4px}',
      '.dk-tip .dk-ops{display:flex;gap:6px}',
      '.dk-tip .dk-ops button{border:1px solid #d5dce5;background:#fff;color:#5b6b7b;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12.5px;font-family:inherit}',
      '.dk-tip .dk-ops button.dk-next{background:#1f6feb;color:#fff;border-color:#1f6feb}',
      '.dk-tip .dk-ops button:hover{filter:brightness(.97)}',
      '.dk-tip .dk-skip{color:#9aa6b2;background:none;border:none;cursor:pointer;font-size:12px;padding:0}',
      '@media(max-width:520px){.dk-tip{max-width:calc(100vw - 32px)}}'
    ].join('\n');
    document.head.appendChild(style);

    document.body.appendChild(mask);
    document.body.appendChild(spot);
    document.body.appendChild(tip);
    document.body.appendChild(btn);

    var idx = 0, open = false;
    mask.style.display = spot.style.display = tip.style.display = 'none';

    function place() {
      var step = steps[idx];
      var el = first(step.sel);
      var r = el ? el.getBoundingClientRect() : null;
      var pad = 8;
      if (r && r.width > 0 && r.height > 0) {
        spot.style.display = 'block';
        spot.style.left = (r.left - pad) + 'px';
        spot.style.top = (r.top - pad) + 'px';
        spot.style.width = (r.width + pad * 2) + 'px';
        spot.style.height = (r.height + pad * 2) + 'px';
      } else {
        spot.style.display = 'none';
        r = { left: innerWidth / 2 - 1, top: innerHeight / 2 - 1, width: 2, height: 2, bottom: innerHeight / 2 + 1 };
      }
      tip.style.display = 'block';
      var tw = Math.min(330, innerWidth - 32);
      var th = tip.offsetHeight || 150;
      var left = Math.max(12, Math.min(r.left, innerWidth - tw - 12));
      var top = r.bottom + pad + 12;
      if (top + th > innerHeight - 12) top = Math.max(12, r.top - th - pad - 12);
      tip.style.width = tw + 'px';
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function render() {
      var step = steps[idx];
      var dots = steps.map(function (_, i) { return '<i class="' + (i === idx ? 'on' : '') + '"></i>'; }).join('');
      tip.innerHTML = '<div class="dk-t">' + step.t + '</div>' +
        '<div class="dk-d">' + step.d + '</div>' +
        '<div class="dk-bar"><div class="dk-dots">' + dots + '</div>' +
        '<div class="dk-ops">' +
        '<button class="dk-prev"' + (idx === 0 ? ' disabled' : '') + '>上一步</button>' +
        '<button class="dk-next">' + (idx === steps.length - 1 ? '完成 ✓' : '下一步 ›') + '</button>' +
        '</div></div>' +
        '<div style="text-align:right;margin-top:8px"><button class="dk-skip">跳过引导</button></div>';
      tip.querySelector('.dk-prev').onclick = function () { if (idx > 0) { idx--; render(); } };
      tip.querySelector('.dk-next').onclick = function () {
        if (idx === steps.length - 1) { close(); return; }
        idx++; render();
      };
      tip.querySelector('.dk-skip').onclick = close;
      place();
    }

    function start() {
      open = true; idx = 0;
      mask.style.display = 'block';
      btn.style.display = 'none';
      render();
    }
    function close() {
      open = false;
      mask.style.display = spot.style.display = tip.style.display = 'none';
      btn.style.display = '';
      try { localStorage.setItem('itck_demo_guide_seen', '1'); } catch (e) {}
    }

    btn.onclick = start;
    mask.onclick = close;
    window.addEventListener('resize', function () { if (open) place(); });
    document.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight' && idx < steps.length - 1) { idx++; render(); }
      if (e.key === 'ArrowLeft' && idx > 0) { idx--; render(); }
    });
  })();
})();
