// The dashboard page, served at / (behind Cloudflare Access in production). It
// reads /v1/stats/<view> (stats.mjs) and draws everything itself, charts as
// inline SVG, with no external resources. app() runs in the browser: it is
// serialized into the page, so it must not use anything from this module.
//
// Chart colours are the data-viz reference palette, validated on the card
// surfaces (#ffffff, #1c1c1e): categorical slots 1-3 for series, an ordinal
// blue ramp for thermal states. Status colours mark only deltas, beside an
// arrow and a label.

const CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;--line:rgba(0,0,0,.09);
--grid:rgba(0,0,0,.06);--axis:rgba(0,0,0,.2);--fill:rgba(118,118,128,.12);--hover:rgba(0,0,0,.035);
--band:rgba(0,0,0,.045);--accent:#0071e3;--bar:rgba(245,245,247,.78);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--t0:#86b6ef;--t1:#3987e5;--t2:#1c5cab;--t3:#0d366b;
--neutral:#a1a1a6;--good:#0ca30c;--critical:#d03b3b;--note:rgba(250,178,25,.2);
--shadow:0 1px 1px rgba(0,0,0,.03),0 4px 18px rgba(0,0,0,.05);--tip:0 6px 24px rgba(0,0,0,.14);
color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--ink:#f5f5f7;--ink2:#a1a1a6;
--ink3:#6e6e73;--line:rgba(255,255,255,.11);--grid:rgba(255,255,255,.08);--axis:rgba(255,255,255,.26);
--fill:rgba(118,118,128,.24);--hover:rgba(255,255,255,.045);--band:rgba(255,255,255,.06);
--accent:#2997ff;--bar:rgba(22,22,23,.8);--s1:#3987e5;--s2:#d95926;--s3:#199e70;
--t0:#184f95;--t1:#256abf;--t2:#3987e5;--t3:#86b6ef;--neutral:#636366;--note:rgba(250,178,25,.22);
--shadow:none;--tip:0 6px 24px rgba(0,0,0,.5);color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;
-webkit-font-smoothing:antialiased;font-feature-settings:"kern"}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
button,select,input{font:inherit;color:inherit}
.wrap{max-width:1240px;margin:0 auto;padding:0 max(20px,env(safe-area-inset-left))}
.hero{padding-block:44px 18px}
.eyebrow{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--ink2);letter-spacing:.01em}
.title-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h1{margin:0;font:700 34px/1.12 -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;letter-spacing:-.022em}
.lede{margin:8px 0 0;color:var(--ink2);font-size:15px}
.note-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
background:var(--note);font-size:12.5px;font-weight:600}
.bar{position:sticky;top:0;z-index:20;background:var(--bar);
-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);
border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
.bar .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 18px;padding-block:10px}
.seg{display:inline-flex;background:var(--fill);border-radius:9px;padding:2px;gap:2px}
.seg button{border:0;background:none;border-radius:7px;padding:5px 13px;font-size:13px;font-weight:500;
color:var(--ink);cursor:pointer;white-space:nowrap}
.seg button[aria-selected=true],.seg button[aria-pressed=true]{background:var(--card);
box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.04);font-weight:600}
.seg button:focus-visible,.pick select:focus-visible,.switch input:focus-visible+span,
tr[tabindex]:focus-visible,.list a:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:1px}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.pick{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--ink2)}
.pick select{appearance:none;-webkit-appearance:none;border:0;background:var(--fill);border-radius:8px;
padding:5px 26px 5px 10px;font-size:13px;color:var(--ink);max-width:220px;cursor:pointer;
background-image:linear-gradient(45deg,transparent 50%,var(--ink2) 50%),linear-gradient(135deg,var(--ink2) 50%,transparent 50%);
background-position:calc(100% - 13px) 52%,calc(100% - 9px) 52%;background-size:4px 4px;background-repeat:no-repeat}
.switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2);cursor:pointer;user-select:none}
.switch input{position:absolute;opacity:0;pointer-events:none}
.switch span{width:34px;height:20px;border-radius:999px;background:var(--fill);position:relative;transition:background .2s}
.switch span:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
.switch input:checked+span{background:#34c759}.switch input:checked+span:after{transform:translateX(14px)}
main{padding-block:22px 40px;min-height:60vh}
main[aria-busy=true] .content{opacity:.45;transition:opacity .15s .1s}
.content>*+*{margin-top:20px}
.back{display:inline-flex;align-items:center;gap:4px;font-size:14px;font-weight:500}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px}
h2{margin:0;font:700 26px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;letter-spacing:-.018em}
h2.mono{font:600 18px/1.35 "SF Mono",ui-monospace,Menlo,monospace;letter-spacing:0;word-break:break-word}
.page-sub{margin:6px 0 0;color:var(--ink2);display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.pill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--fill);
font-size:12px;font-weight:600;color:var(--ink2);white-space:nowrap}
.pill.new{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.mono{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12.5px}
.muted{color:var(--ink2)}.faint{color:var(--ink3)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.kpis.n6{grid-template-columns:repeat(3,1fr)}.kpis.n5{grid-template-columns:repeat(5,1fr)}
.kpis.n4{grid-template-columns:repeat(4,1fr)}
@media (min-width:1180px){.kpis.n6{grid-template-columns:repeat(6,1fr)}}
@media (max-width:900px){.kpis.n4,.kpis.n5{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--card);border-radius:16px;padding:16px 18px 15px;box-shadow:var(--shadow);min-width:0}
.kpi .label{font-size:13px;color:var(--ink2);font-weight:500}
.kpi .value{font:600 28px/1.15 -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;
letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi .value small{font-size:15px;font-weight:500;color:var(--ink2);margin-left:3px;letter-spacing:0}
.kpi .sub{font-size:12px;color:var(--ink2);margin-top:4px}
.card .kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card .kpis.n4{grid-template-columns:repeat(2,1fr)}
.card .kpi{box-shadow:none;background:var(--fill);border-radius:12px;padding:12px 14px}
.card .kpi .value{font-size:22px}
.delta{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--ink2);margin-top:6px;font-variant-numeric:tabular-nums}
.delta i{font-style:normal;font-size:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,470px),1fr));gap:20px}
.card{background:var(--card);border-radius:18px;padding:20px 22px;box-shadow:var(--shadow);min-width:0}
.card-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:10px 12px;margin-bottom:14px}
.card-head>div:first-child{flex:1 1 320px;min-width:0}
h3{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em}
.card-sub{margin:3px 0 0;color:var(--ink2);font-size:13px}
.toggle{border:0;background:var(--fill);border-radius:7px;padding:3px 9px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--ink2);margin:-4px 0 10px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.chart{position:relative;width:100%}
.chart svg{display:block;overflow:visible}
.chart text{fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto;margin:0 -22px;padding:0 22px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:var(--ink2);font-weight:600;font-size:12px;padding:0 10px 8px;white-space:nowrap;
border-bottom:1px solid var(--line);vertical-align:bottom}
th[data-sort]{cursor:pointer;user-select:none}th[data-sort]:hover{color:var(--ink)}
th[aria-sort]:after{content:"";display:inline-block;margin-left:4px;border:4px solid transparent;vertical-align:1px}
th[aria-sort=descending]:after{border-top-color:currentColor;border-bottom:0}
th[aria-sort=ascending]:after{border-bottom-color:currentColor;border-top:0}
td{padding:9px 10px;border-top:1px solid var(--line);vertical-align:middle}
tbody tr:first-child td{border-top:0}
th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr[tabindex]{cursor:pointer}tr[tabindex]:hover td{background:var(--hover)}
td .chev{color:var(--ink3);font-size:15px}
.game{display:flex;flex-direction:column;min-width:170px}
.game b{font-weight:600}.game span{font-size:11.5px;color:var(--ink2)}
.sig{font:12px/1.45 "SF Mono",ui-monospace,Menlo,monospace;overflow-wrap:anywhere;min-width:280px;max-width:560px}
.nowrap{white-space:nowrap}
.clip{display:block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list{display:flex;flex-direction:column}
.list a{display:grid;grid-template-columns:1fr auto;gap:2px 14px;align-items:center;padding:10px 0;
border-top:1px solid var(--line);color:inherit;text-decoration:none}
.list a:first-child{border-top:0;padding-top:2px}
.list a:hover .t{color:var(--accent)}
.list .t{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis}
.list .t.mono{font-weight:500;white-space:normal;word-break:break-word}
.list .m{font-size:12px;color:var(--ink2)}
.list .v{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;grid-row:span 2}
.list .v small{display:block;font-weight:400;font-size:12px;color:var(--ink2)}
.hbars{display:flex;flex-direction:column;gap:9px}
.hbar{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:10px;align-items:center;font-size:13px}
.hbar .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar .track{height:8px;border-radius:4px;background:var(--fill);overflow:hidden}
.hbar .fill{height:100%;border-radius:4px;background:var(--s1);min-width:2px}
.hbar .n{font-variant-numeric:tabular-nums;color:var(--ink2);min-width:56px;text-align:right}
.stack-rows{display:flex;flex-direction:column;gap:12px}
.stack-row{display:grid;grid-template-columns:110px 1fr;gap:12px;align-items:center;font-size:13px}
.stack{display:flex;gap:2px;height:16px}
.stack div{height:100%;min-width:2px}
.stack div:first-child{border-radius:4px 0 0 4px}.stack div:last-child{border-radius:0 4px 4px 0}
.stack div:only-child{border-radius:4px}
.frames{counter-reset:f;font:12px/1.5 "SF Mono",ui-monospace,Menlo,monospace}
.frames td{padding:5px 10px;border-top:1px solid var(--line)}
.frames .img{color:var(--ink2);white-space:nowrap}
.frames tr.dim td{color:var(--ink3)}
.fact{margin:0 0 8px;font-size:13px;color:var(--ink2)}
.message{font:12.5px/1.5 "SF Mono",ui-monospace,Menlo,monospace;background:var(--fill);border-radius:10px;
padding:10px 12px;white-space:pre-wrap;word-break:break-word;margin:0 0 14px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
color:var(--ink2);text-align:center;padding:36px 12px;font-size:14px}
.empty b{color:var(--ink);font-size:15px}
.skeleton{height:96px;border-radius:16px;background:linear-gradient(90deg,var(--card) 0%,var(--hover) 50%,var(--card) 100%);
background-size:200% 100%;animation:shimmer 1.4s infinite}
@keyframes shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.skeleton{animation:none}*{transition:none!important}}
.search{border:0;background:var(--fill);border-radius:9px;padding:6px 11px;font-size:13px;width:min(260px,100%)}
#tip{position:fixed;z-index:50;pointer-events:none;background:var(--card);color:var(--ink);border-radius:10px;
box-shadow:var(--tip);padding:9px 11px;font-size:12px;min-width:150px;max-width:300px;border:.5px solid var(--line)}
#tip .tt{font-weight:600;margin-bottom:5px}
#tip .row{display:flex;align-items:center;gap:7px;justify-content:space-between}
#tip .row span:first-child{display:inline-flex;align-items:center;gap:6px;color:var(--ink2)}
#tip .row b{font-weight:600;font-variant-numeric:tabular-nums}
#tip .foot{margin-top:5px;color:var(--ink2)}
footer{color:var(--ink3);font-size:12px;padding-block:8px 48px;line-height:1.6}
@media (max-width:640px){.kpis.n6{grid-template-columns:repeat(2,1fr)}.hero{padding-top:28px}h1{font-size:28px}h2{font-size:22px}
.card{padding:16px}.scroll{margin:0 -16px;padding:0 16px}.kpi .value{font-size:24px}
.bar .wrap{flex-direction:column;align-items:stretch}.bar .seg{display:flex}.bar .seg button{flex:1;padding:6px 2px;font-size:12.5px}
.filters{display:grid;grid-template-columns:1fr 1fr;gap:8px}.filters .seg,.filters .switch{grid-column:1/-1}
.pick{min-width:0}.pick select{width:100%;max-width:none;min-width:0}.stack-row{grid-template-columns:84px 1fr}}
`;

function app() {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const h = (tag, attrs, ...kids) => build(document.createElement(tag), attrs, kids);
  const s = (tag, attrs, ...kids) => build(document.createElementNS(SVG, tag), attrs, kids);
  function build(el, attrs, kids) {
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  // ---- Formatting

  const nf = new Intl.NumberFormat('en-US');
  const int = (n) => (n === null || n === undefined ? '–' : nf.format(Math.round(n)));
  const fixed = (n, d = 1) => (n === null || n === undefined ? '–' : n.toFixed(d));
  const pct = (n) => {
    if (n === null || n === undefined) return '–';
    return `${n >= 99 && n < 100 ? Number(n.toFixed(2)) : Number(n.toFixed(1))}%`;
  };
  const hours = (hr) => {
    if (hr === null || hr === undefined) return '–';
    if (hr < 1) return `${Math.round(hr * 60)} min`;
    return hr < 100 ? `${hr.toFixed(1)} h` : `${nf.format(Math.round(hr))} h`;
  };
  const secs = (n) => (n === null || n === undefined ? '–' : `${n.toFixed(1)} s`);
  const mb = (n) => (n === null || n === undefined ? '–' : n >= 1024 ? `${(n / 1024).toFixed(2)} GB`
                                                                      : `${nf.format(n)} MB`);
  const dayDate = (day) => new Date(`${day}T00:00:00Z`);
  const shortDay = (day) => dayDate(day).toLocaleDateString('en-US',
      {month: 'short', day: 'numeric', timeZone: 'UTC'});
  const longDay = (day) => dayDate(day).toLocaleDateString('en-US',
      {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'});
  const SOURCES = {app: 'App', extension: 'Crash reporter', metrickit: 'MetricKit'};
  const ENDS = {normal: 'Stopped normally', background: 'Ended in the background',
                terminated: 'Closed by the player', crash: 'Crashed', fatal: 'Fatal error',
                killed: 'Killed in foreground', unknown: 'Unknown', unfinished: 'Unfinished'};
  const STATUS = {playable: 'Playable', ingame: 'In game', loads: 'Loads', intro: 'Intro',
                  menus: 'Menus', nothing: 'Doesn’t boot'};
  const PACING = {capped: 'Capped', uncapped: 'Uncapped', mixed: 'Changed during play'};
  const gameName = (g) => g.name || g.titleId || 'Unknown game';

  // ---- State, kept in the URL hash: #/<view>[/<item>]?days=&unofficial=&build=&device=

  const state = {parts: [], days: 7, unofficial: false, build: '', device: ''};
  function readHash() {
    const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
    const p = new URLSearchParams(query);
    state.parts = path.split('/').filter(Boolean).map((x) => {
      try { return decodeURIComponent(x); } catch { return x; }
    });
    state.days = [7, 30, 90].includes(Number(p.get('days'))) ? Number(p.get('days')) : 7;
    state.unofficial = p.get('unofficial') === '1';
    state.build = p.get('build') ?? '';
    state.device = p.get('device') ?? '';
  }
  function query(extra = {}) {
    const p = new URLSearchParams();
    if (state.days !== 7) p.set('days', state.days);
    if (state.unofficial) p.set('unofficial', '1');
    if (state.build) p.set('build', state.build);
    if (state.device) p.set('device', state.device);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }
  const href = (...parts) => {
    const q = query();
    return `#/${parts.map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;
  };
  const go = (...parts) => { location.hash = href(...parts); };

  const cache = new Map();
  async function api(view, extra = {}) {
    const url = `/v1/stats/${view}?${query({days: state.days, ...extra})}`;
    if (cache.has(url)) return cache.get(url);
    const response = await fetch(url, {headers: {Accept: 'application/json'}});
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    cache.set(url, data);
    return data;
  }

  // ---- Tooltip

  const tip = $('tip');
  function showTip(event, title, rows, foot) {
    tip.replaceChildren(
        h('div', {class: 'tt'}, title),
        ...rows.map(([color, label, value]) => h('div', {class: 'row'},
            h('span', {}, color ? h('i', {class: 'sw', style: {background: color}}) : null, label),
            h('b', {}, value))),
        ...(foot ? [h('div', {class: 'foot'}, foot)] : []));
    tip.hidden = false;
    moveTip(event);
  }
  function moveTip(event) {
    const pad = 14;
    const {width, height} = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + width > innerWidth - 8) x = event.clientX - width - pad;
    if (y + height > innerHeight - 8) y = event.clientY - height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ---- Charts

  const cssVar = (name) => `var(--${name})`;

  // Counts (whole: true) step by whole numbers.
  function niceTicks(lo, hi, count = 4, whole = false) {
    if (!(hi > lo)) hi = lo + 1;
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
    if (whole) step = Math.max(1, Math.ceil(step));
    const start = Math.floor(lo / step + 1e-9) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 0.999; v += step) ticks.push(Number(v.toFixed(6)));
    return ticks;
  }

  // A box that draws its chart at its own width, and again when that changes.
  function chartBox(height, draw) {
    const box = h('div', {class: 'chart', style: {height: `${height}px`}});
    let drawn = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      if (width > 0 && width !== drawn) {
        drawn = width;
        box.replaceChildren(draw(width, height));
      }
    }).observe(box);
    return box;
  }

  function roundedTop(x, y, w, ht, r) {
    r = Math.max(0, Math.min(r, w / 2, ht));
    return `M${x},${y + ht}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}` +
           `V${y + ht}Z`;
  }

  // Shared frame of the time and category charts: y grid and labels, x labels.
  function frame(width, height, labels, ticks, yFormat, xLabel) {
    const m = {left: 46, right: 8, top: 8, bottom: 24};
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const lo = ticks[0];
    const hi = ticks.at(-1);
    const y = (v) => m.top + plotH - ((v - lo) / (hi - lo)) * plotH;
    const band = plotW / labels.length;
    const cx = (i) => m.left + band * (i + 0.5);
    const svg = s('svg', {width, height, viewBox: `0 0 ${width} ${height}`, role: 'img'});
    for (const t of ticks) {
      svg.append(s('line', {x1: m.left, x2: width - m.right, y1: y(t), y2: y(t),
                            stroke: cssVar(t === lo && lo === 0 ? 'axis' : 'grid')}));
      svg.append(s('text', {x: m.left - 8, y: y(t) + 3.5, 'text-anchor': 'end'}, yFormat(t)));
    }
    const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(plotW / 64))));
    const allFit = band >= 36;
    labels.forEach((label, i) => {
      if (i % every === 0 || allFit) {
        svg.append(s('text', {x: cx(i), y: height - 6, 'text-anchor': 'middle'}, xLabel(label)));
      }
    });
    const highlight = s('rect', {x: 0, y: m.top, width: band, height: plotH, rx: 4,
                                 fill: cssVar('band'), opacity: 0});
    svg.append(highlight);
    return {svg, m, plotW, plotH, y, band, cx, highlight};
  }

  // Hover over a band: highlight it and show the tooltip from tipFor(i).
  function bandHover(f, count, tipFor, onMove) {
    const overlay = s('rect', {x: f.m.left, y: f.m.top, width: f.plotW, height: f.plotH,
                               fill: 'transparent', style: 'cursor:crosshair'});
    const at = (event) => {
      const r = overlay.getBoundingClientRect();
      return Math.max(0, Math.min(count - 1, Math.floor((event.clientX - r.left) / f.band)));
    };
    overlay.addEventListener('pointermove', (event) => {
      const i = at(event);
      f.highlight.setAttribute('x', f.m.left + f.band * i);
      f.highlight.setAttribute('opacity', 1);
      onMove?.(i);
      const [title, rows, foot] = tipFor(i);
      showTip(event, title, rows, foot);
    });
    overlay.addEventListener('pointerleave', () => {
      f.highlight.setAttribute('opacity', 0);
      onMove?.(null);
      hideTip();
    });
    f.svg.append(overlay);
  }

  // Bars per label; series stack (or sit side by side with stacked: false).
  function barChart({labels, series, height = 220, yFormat = int, xLabel = shortDay,
                     stacked = true, tipTitle = longDay, total = true, foot = null}) {
    return chartBox(height, (width) => {
      const sums = labels.map((_, i) => (stacked ? series.reduce((a, se) => a + (se.values[i] ?? 0), 0)
                                                 : Math.max(...series.map((se) => se.values[i] ?? 0))));
      const ticks = niceTicks(0, Math.max(...sums, 0) || 1, 4, yFormat === int);
      const f = frame(width, height, labels, ticks, yFormat, xLabel);
      const groupW = Math.min(stacked ? 30 : 44, f.band * (stacked ? 0.64 : 0.78));
      const barW = stacked ? groupW : (groupW - 2 * (series.length - 1)) / series.length;
      labels.forEach((_, i) => {
        if (stacked) {
          let base = f.y(0);
          const parts = series.map((se) => [se, se.values[i] ?? 0]).filter(([, v]) => v > 0);
          parts.forEach(([se, v], j) => {
            const ht = f.y(0) - f.y(v);
            const gap = j > 0 && ht > 3 ? 2 : 0;
            const y0 = base - ht;
            const x = f.cx(i) - barW / 2;
            const last = j === parts.length - 1;
            f.svg.append(last ? s('path', {d: roundedTop(x, y0, barW, ht - gap, 4), fill: se.color})
                              : s('rect', {x, y: y0, width: barW, height: Math.max(1, ht - gap),
                                           fill: se.color}));
            base = y0;
          });
        } else {
          series.forEach((se, j) => {
            const v = se.values[i] ?? 0;
            if (!(v > 0)) return;
            const x = f.cx(i) - groupW / 2 + j * (barW + 2);
            f.svg.append(s('path', {d: roundedTop(x, f.y(v), barW, f.y(0) - f.y(v), 4), fill: se.color}));
          });
        }
      });
      bandHover(f, labels.length, (i) => {
        const rows = series.map((se) => [se.color, se.name, yFormat(se.values[i] ?? 0)]);
        if (stacked && total && series.length > 1) rows.push([null, 'Total', yFormat(sums[i])]);
        return [tipTitle(labels[i]), rows, foot?.(i)];
      });
      return f.svg;
    });
  }

  // Lines over days; a gap where a value is null, a dot where a point stands alone.
  function lineChart({labels, series, height = 220, yFormat = fixed, domain = null,
                      xLabel = shortDay, tipTitle = longDay, foot = null}) {
    return chartBox(height, (width) => {
      const values = series.flatMap((se) => se.values).filter((v) => v !== null && v !== undefined);
      const [lo, hi] = domain ? domain(values) : [0, Math.max(...values, 0) || 1];
      const ticks = niceTicks(lo, hi);
      const f = frame(width, height, labels, ticks, yFormat, xLabel);
      for (const se of series) {
        let d = '';
        se.values.forEach((v, i) => {
          if (v === null || v === undefined) return;
          const prev = se.values[i - 1];
          d += `${prev === null || prev === undefined ? 'M' : 'L'}${f.cx(i)},${f.y(v)}`;
        });
        f.svg.append(s('path', {d, fill: 'none', stroke: se.color, 'stroke-width': 2,
                                'stroke-linejoin': 'round', 'stroke-linecap': 'round'}));
        se.values.forEach((v, i) => {
          const alone = (x) => x === null || x === undefined;
          if (!alone(v) && alone(se.values[i - 1]) && alone(se.values[i + 1])) {
            f.svg.append(s('circle', {cx: f.cx(i), cy: f.y(v), r: 4, fill: se.color,
                                      stroke: cssVar('card'), 'stroke-width': 2}));
          }
        });
      }
      const cross = s('line', {y1: f.m.top, y2: f.m.top + f.plotH, stroke: cssVar('axis'),
                               'stroke-width': 1, opacity: 0});
      const dots = series.map((se) => s('circle', {r: 4.5, fill: se.color, stroke: cssVar('card'),
                                                    'stroke-width': 2, opacity: 0}));
      f.svg.append(cross, ...dots);
      f.highlight.remove();
      f.highlight = s('rect');
      bandHover(f, labels.length, (i) => [tipTitle(labels[i]),
        series.map((se) => [se.color, se.name, se.values[i] === null || se.values[i] === undefined
                                                ? 'No data' : yFormat(se.values[i])]), foot?.(i)],
      (i) => {
        cross.setAttribute('opacity', i === null ? 0 : 1);
        if (i !== null) cross.setAttribute('x1', f.cx(i)), cross.setAttribute('x2', f.cx(i));
        series.forEach((se, j) => {
          const v = se.values[i ?? 0];
          const show = i !== null && v !== null && v !== undefined;
          dots[j].setAttribute('opacity', show ? 1 : 0);
          if (show) dots[j].setAttribute('cx', f.cx(i)), dots[j].setAttribute('cy', f.y(v));
        });
      });
      return f.svg;
    });
  }

  // A tiny bar per day for table rows.
  function sparkline(perDay, days, width = 92, height = 26) {
    const max = Math.max(1, ...days.map((d) => perDay[d] ?? 0));
    const band = width / days.length;
    const w = Math.max(1, Math.min(6, band - 1));
    const svg = s('svg', {width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true'});
    days.forEach((d, i) => {
      const v = perDay[d] ?? 0;
      const ht = v ? Math.max(2, (v / max) * (height - 2)) : 1;
      svg.append(s('rect', {x: i * band + (band - w) / 2, y: height - ht, width: w, height: ht, rx: v ? 1 : 0,
                            fill: v ? cssVar('s1') : cssVar('grid')}));
    });
    return svg;
  }

  function legend(series) {
    return h('div', {class: 'legend'}, series.map((se) => h('span', {},
        h('i', {class: 'sw', style: {background: se.color}}), se.name)));
  }

  function hbars(rows, {format = int, link = null, max = null} = {}) {
    if (!rows.length) return empty('Nothing to show', null);
    const top = max ?? Math.max(...rows.map((r) => r.value), 1);
    return h('div', {class: 'hbars'}, rows.map((r) => h('div', {class: 'hbar'},
        h('div', {class: 'k', title: r.title ?? r.label},
          link && r.link ? h('a', {href: r.link}, r.label) : r.label),
        h('div', {class: 'track'}, h('div', {class: 'fill', style: {width: `${(100 * r.value) / top}%`}})),
        h('div', {class: 'n'}, r.text ?? format(r.value)))));
  }

  // ---- Building blocks

  function empty(title, text) {
    return h('div', {class: 'empty'}, h('b', {}, title), text ? h('div', {}, text) : null);
  }

  function card(title, sub, body, {table = null, legendFor = null, action = null} = {}) {
    const holder = h('div', {}, body);
    let showingTable = false;
    const toggle = table ? h('button', {class: 'toggle', type: 'button', 'aria-pressed': 'false',
      onclick: () => {
        showingTable = !showingTable;
        toggle.setAttribute('aria-pressed', String(showingTable));
        toggle.textContent = showingTable ? 'Chart' : 'Table';
        holder.replaceChildren(showingTable ? h('div', {class: 'scroll'}, table()) : body);
      }}, 'Table') : null;
    return h('section', {class: 'card'},
        h('div', {class: 'card-head'},
          h('div', {}, h('h3', {}, title), sub ? h('p', {class: 'card-sub'}, sub) : null),
          action ?? toggle),
        legendFor ? legend(legendFor) : null,
        holder);
  }

  function delta(now, before, {better = null, unit = 'rel', days}) {
    if (now === null || now === undefined || before === null || before === undefined) {
      return h('div', {class: 'delta'}, `No data in the previous ${days} days`);
    }
    const diff = unit === 'pts' ? now - before : before ? (100 * (now - before)) / before : null;
    if (diff === null) return h('div', {class: 'delta'}, `None in the previous ${days} days`);
    const flat = Math.abs(diff) < (unit === 'pts' ? 0.05 : 0.5);
    const up = diff > 0;
    const good = better === null || flat ? null : (up === (better === 'up'));
    const color = good === null ? cssVar('ink3') : good ? cssVar('good') : cssVar('critical');
    const amount = unit === 'pts' ? `${Math.abs(diff).toFixed(Math.abs(diff) < 1 ? 2 : 1)} pts`
                                  : `${Math.abs(diff).toFixed(0)}%`;
    return h('div', {class: 'delta'},
        h('i', {style: {color}, 'aria-hidden': 'true'}, flat ? '●' : up ? '▲' : '▼'),
        flat ? `Unchanged from the previous ${days} days`
             : `${up ? 'Up' : 'Down'} ${amount} from the previous ${days} days`);
  }

  function kpis(tiles) {
    return h('div', {class: `kpis n${tiles.length}`}, tiles.map((t) => h('div', {class: 'kpi', title: t.title ?? null},
        h('div', {class: 'label'}, t.label),
        h('div', {class: 'value'}, t.value, t.unit ? h('small', {}, t.unit) : null),
        t.sub ? h('div', {class: 'sub'}, t.sub) : null,
        t.delta ?? null)));
  }

  // A sortable table. columns: [{key, label, num, value(row), render(row), sort}].
  function table(columns, rows, {onRow = null, sort = null, emptyText = 'Nothing in this range'} = {}) {
    if (!rows.length) return empty(emptyText, null);
    let by = sort?.key ?? null;
    let dir = sort?.dir ?? 'descending';
    const body = h('tbody');
    const head = h('tr', {}, columns.map((c) => h('th', {
      class: c.num ? 'num' : null, 'data-sort': c.value ? c.key : null, scope: 'col',
      'aria-sort': c.key === by ? dir : null,
      onclick: c.value ? () => {
        dir = by === c.key && dir === 'descending' ? 'ascending' : 'descending';
        by = c.key;
        head.querySelectorAll('th').forEach((th) => th.removeAttribute('aria-sort'));
        head.querySelector(`th[data-sort="${c.key}"]`).setAttribute('aria-sort', dir);
        fill();
      } : null}, c.label)), onRow ? h('th', {'aria-hidden': 'true'}) : null);
    function fill() {
      const col = columns.find((c) => c.key === by);
      const sorted = col ? rows.slice().sort((a, b) => {
        const x = col.value(a);
        const y = col.value(b);
        const nx = x === null || x === undefined;
        const ny = y === null || y === undefined;
        if (nx || ny) return nx - ny;
        const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
        return dir === 'ascending' ? c : -c;
      }) : rows;
      body.replaceChildren(...sorted.map((r) => h('tr', onRow ? {
        tabindex: 0, onclick: () => onRow(r),
        onkeydown: (e) => { if (e.key === 'Enter') onRow(r); }} : {},
        columns.map((c) => h('td', {class: c.num ? 'num' : null}, c.render ? c.render(r) : c.value(r))),
        onRow ? h('td', {class: 'num'}, h('span', {class: 'chev', 'aria-hidden': 'true'}, '›')) : null)));
    }
    fill();
    return h('table', {}, h('thead', {}, head), body);
  }

  // A signature that wraps at "::" and " < " rather than inside a name.
  const sigText = (sig) => sig.split(/(?<=::|\s)/).flatMap((part) => [part, h('wbr')]);

  const gameCell = (g) => h('div', {class: 'game'}, h('b', {}, gameName(g)),
                              h('span', {class: 'mono'}, g.titleId));

  function rangeDays(meta) {
    const days = [];
    for (let d = dayDate(meta.since); d <= dayDate(meta.today); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    return days;
  }
  const align = (days, rows, f) => {
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));
    return days.map((d) => (byDay[d] ? f(byDay[d]) : null));
  };

  // Crash-free share per day: lines keep a zoomed scale, never below what the data needs.
  const crashFreeDomain = (values) => {
    const low = Math.min(...values, 100);
    return [Math.max(0, low - Math.max(0.5, (100 - low) * 0.35)), 100];
  };

  // ---- Views

  async function overview(meta) {
    const d = await api('overview');
    const c = d.current;
    const p = d.previous;
    const days = rangeDays(meta);
    const n = meta.days;
    if (!c.sessions && !c.crashReports) return [noData(meta)];
    return [
      kpis([
        {label: 'Crash-free sessions', value: pct(c.crashFreePct),
         sub: `${int(c.crashed + c.fatal + c.killed)} of ${int(c.sessions)} ended badly`,
         delta: delta(c.crashFreePct, p.sessions ? p.crashFreePct : null, {better: 'up', unit: 'pts', days: n})},
        {label: 'Sessions', value: int(c.sessions), sub: 'Games started and stopped',
         delta: delta(c.sessions, p.sessions || null, {days: n})},
        {label: 'Play time', value: hours(c.playHours), sub: 'In the foreground',
         delta: delta(c.playHours, p.playHours || null, {days: n})},
        {label: 'Crash reports', value: int(c.crashReports),
         sub: `${int(c.crashGroups)} groups, ${int(c.newGroups)} new`,
         delta: delta(c.crashReports, p.crashReports || null, {better: 'down', days: n})},
        {label: 'Killed in foreground', value: int(c.killed), sub: 'Memory limit or watchdog',
         title: 'Ended by iOS while on screen without a crash: usually the memory limit.',
         delta: delta(c.killed, p.sessions ? p.killed : null, {better: 'down', days: n})},
        {label: 'Running hot', value: pct(c.hotPct), sub: 'Time at Serious or Critical',
         delta: delta(c.hotPct, p.sessions ? p.hotPct : null, {better: 'down', unit: 'pts', days: n})},
      ]),
      h('div', {class: 'grid'},
        card('Crash-free sessions', 'Per day. A session that crashed, hit a fatal error or was killed in the foreground isn’t crash-free.',
          lineChart({labels: days, height: 230, yFormat: (v) => `${Number(v.toFixed(2))}%`,
                     domain: crashFreeDomain,
                     series: [{name: 'Crash-free', color: cssVar('s1'),
                               values: align(days, d.daily, (r) => r.crashFreePct)}],
                     foot: (i) => {
                       const r = d.daily.find((x) => x.day === days[i]);
                       return r ? `${int(r.sessions)} sessions` : 'No sessions';
                     }}),
          {table: () => dailyTable(days, d.daily)}),
        card('Sessions', 'Per day, by how they ended.',
          barChart({labels: days, height: 230, series: outcomeSeries(days, d.daily, true)}),
          {legendFor: outcomeSeries(days, d.daily, true), table: () => dailyTable(days, d.daily)})),
      h('div', {class: 'grid'},
        card('Top crashes', 'Grouped by the top three XeniOS frames.',
          d.topCrashes.length ? crashList(d.topCrashes, days)
                              : empty('No crashes', 'Nothing crashed in this range.'),
          {action: h('a', {href: href('crashes')}, 'All crashes')}),
        card('Most played', 'By play time. Frame rates are from capped play.',
          d.topTitles.length ? h('div', {class: 'list'}, d.topTitles.map((g) => h('a', {href: href('games', g.titleId)},
            h('div', {class: 't'}, gameName(g)),
            h('div', {class: 'v'}, hours(g.playHours), h('small', {}, `${fixed(g.medianFps)} fps median`)),
            h('div', {class: 'm'}, `${int(g.sessions)} sessions · ${pct(g.crashFreePct)} crash-free`))))
                             : empty('No games', null),
          {action: h('a', {href: href('games')}, 'All games')})),
    ];
  }

  function outcomeSeries(days, daily, withClean) {
    const series = [
      {name: 'Crashed', color: cssVar('s1'), values: align(days, daily, (r) => r.crashed)},
      {name: 'Fatal error', color: cssVar('s2'), values: align(days, daily, (r) => r.fatal)},
      {name: 'Killed in foreground', color: cssVar('s3'), values: align(days, daily, (r) => r.killed)},
    ];
    if (!withClean) return series;
    return [{name: 'Ended cleanly', color: cssVar('neutral'),
             values: align(days, daily, (r) => r.sessions - r.crashed - r.fatal - r.killed)}, ...series];
  }

  function dailyTable(days, daily) {
    const rows = days.map((day) => daily.find((r) => r.day === day) ?? {day, sessions: 0})
        .filter((r) => r.sessions).reverse();
    return table([
      {key: 'day', label: 'Day', value: (r) => r.day, render: (r) => longDay(r.day)},
      {key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
      {key: 'crashed', label: 'Crashed', num: true, value: (r) => r.crashed, render: (r) => int(r.crashed)},
      {key: 'fatal', label: 'Fatal', num: true, value: (r) => r.fatal, render: (r) => int(r.fatal)},
      {key: 'killed', label: 'Killed', num: true, value: (r) => r.killed, render: (r) => int(r.killed)},
      {key: 'free', label: 'Crash-free', num: true, value: (r) => r.crashFreePct, render: (r) => pct(r.crashFreePct)},
      {key: 'play', label: 'Play time', num: true, value: (r) => r.playHours, render: (r) => hours(r.playHours)},
    ], rows);
  }

  function crashList(groups, days) {
    return h('div', {class: 'list'}, groups.map((g) => h('a', {href: href('crashes', g.signature)},
        h('div', {class: 't mono'}, sigText(g.signature)),
        h('div', {class: 'v'}, int(g.reports), h('small', {}, g.reports === 1 ? 'report' : 'reports')),
        h('div', {class: 'm'}, g.isNew ? h('span', {class: 'pill new'}, 'New') : null, ' ',
          [g.topGames.map(gameName).join(', ') || 'No game', `${g.models} ${g.models === 1 ? 'device' : 'devices'}`,
           `last ${shortDay(g.lastDay)}`].join(' · ')))));
  }

  async function games(meta) {
    const rows = await api('titles');
    const search = h('input', {class: 'search', type: 'search', placeholder: 'Search games',
                               'aria-label': 'Search games'});
    const holder = h('div', {class: 'scroll'});
    const columns = [
      {key: 'name', label: 'Game', value: (g) => gameName(g).toLowerCase(), render: gameCell},
      {key: 'sessions', label: 'Sessions', num: true, value: (g) => g.sessions, render: (g) => int(g.sessions)},
      {key: 'play', label: 'Play time', num: true, value: (g) => g.playHours, render: (g) => hours(g.playHours)},
      {key: 'free', label: 'Crash-free', num: true, value: (g) => g.crashFreePct, render: (g) => pct(g.crashFreePct)},
      {key: 'fps', label: 'Median fps', num: true, value: (g) => g.medianFps, render: (g) => fixed(g.medianFps)},
      {key: 'low', label: '1% low', num: true, value: (g) => g.low1Fps, render: (g) => fixed(g.low1Fps)},
      {key: 'stutter', label: 'Stutter', num: true, value: (g) => g.stutterPct, render: (g) => pct(g.stutterPct)},
      {key: 'hitches', label: 'Hitches/min', num: true, value: (g) => g.hitchesPerMin, render: (g) => fixed(g.hitchesPerMin)},
      {key: 'compile', label: 'In compiles', num: true, value: (g) => g.compilePct, render: (g) => pct(g.compilePct)},
      {key: 'start', label: 'First frame', num: true, value: (g) => g.firstFrameS, render: (g) => secs(g.firstFrameS)},
      {key: 'gpu', label: 'GPU errors', num: true, value: (g) => g.gpuErrorPct, render: (g) => pct(g.gpuErrorPct)},
      {key: 'hot', label: 'Hot', num: true, value: (g) => g.hotPct, render: (g) => pct(g.hotPct)},
      {key: 'uncapped', label: 'Uncapped', num: true, value: (g) => g.uncappedPct, render: (g) => pct(g.uncappedPct)},
    ];
    const draw = () => {
      const needle = search.value.trim().toLowerCase();
      const shown = needle ? rows.filter((g) => gameName(g).toLowerCase().includes(needle) ||
                                                g.titleId.toLowerCase().includes(needle)) : rows;
      holder.replaceChildren(table(columns, shown, {onRow: (g) => go('games', g.titleId),
        sort: {key: 'play', dir: 'descending'},
        emptyText: needle ? 'No game matches' : 'No sessions in this range'}));
    };
    search.addEventListener('input', draw);
    draw();
    return [
      pageHead('Games', `${int(rows.length)} games played in this range`),
      card('All games', 'Frame rates, stutter and hitches are from capped play (the default). Stutter: time in frames at least 1.5 times the median (a dropped frame or worse). Hitches: frames over 50 ms; “In compiles” is the share that fell during shader compiles. First frame: median time from starting the game. GPU errors: sessions where a GPU command failed.',
        holder, {action: search}),
    ];
  }

  function pageHead(title, sub, extra = null, back = null) {
    return h('div', {},
      back ? h('a', {class: 'back', href: back[1]}, '‹ ', back[0]) : null,
      h('div', {class: 'page-head', style: back ? {marginTop: '8px'} : null},
        h('div', {}, h('h2', {class: title.mono ? 'mono' : null}, title.text ?? title),
          sub ? h('div', {class: 'page-sub'}, sub) : null),
        extra));
  }

  function histogramCard(meta, histogram) {
    const edges = meta.edges;
    const labels = meta.buckets.map((_, i) => i);
    const share = (counts) => {
      const total = counts.reduce((a, b) => a + b, 0);
      return total ? counts.map((c) => (100 * c) / total) : null;
    };
    const capped = share(histogram.capped);
    const uncapped = share(histogram.uncapped);
    const frames = (counts) => counts.reduce((a, b) => a + b, 0);
    const series = [
      capped && {name: 'Capped', color: cssVar('s1'), values: capped, frames: frames(histogram.capped)},
      uncapped && {name: 'Uncapped', color: cssVar('s2'), values: uncapped,
                   frames: frames(histogram.uncapped)},
    ].filter(Boolean);
    if (!series.length) return card('Frame pacing', null, empty('No frames recorded', null));
    const range = (i) => (i === 0 ? `≤ ${edges[0]} ms` : i === edges.length ? `> ${edges.at(-1)} ms`
                                                       : `${edges[i - 1]}–${edges[i]} ms`);
    const fpsRange = (i) => `${meta.buckets[i]} fps`;
    return card('Frame pacing', 'Share of guest frames at each rate. Games present on the 60 Hz vertical blank, so frames gather at 60, 30, 20 and 15 fps; the bars between are frames that missed it.',
      barChart({labels, series, stacked: false, height: 240, yFormat: (v) => `${Number(v.toFixed(1))}%`,
                xLabel: (i) => meta.buckets[i],
                tipTitle: (i) => `${fpsRange(i)} (${range(i)})`,
                foot: () => series.map((se) => `${se.name}: ${int(se.frames)} frames`).join(' · ')}),
      {legendFor: series.length > 1 ? series : null, table: () => table([
        {key: 'f', label: 'Frame rate', value: (r) => r.i, render: (r) => fpsRange(r.i)},
        {key: 'b', label: 'Frame time', render: (r) => range(r.i)},
        ...series.map((se, j) => ({key: `s${j}`, label: se.name, num: true, value: (r) => r.v[j],
                                   render: (r) => `${r.v[j].toFixed(2)}%`})),
      ], labels.map((i) => ({i, v: series.map((se) => se.values[i])})))});
  }

  async function game(meta, titleId) {
    const g = await api('title', {title: titleId});
    if (!g) return [notFound('No such game', href('games'), 'Games')];
    const head = pageHead(gameName(g), [
      h('span', {class: 'mono'}, g.titleId),
      g.status ? h('span', {class: 'pill'}, `Compatibility: ${STATUS[g.status] ?? g.status}`) : null,
    ], null, ['Games', href('games')]);
    if (g.empty) return [head, card('No sessions', null, empty('Nothing in this range', 'Try a longer range or include self-built builds.'))];
    const sm = g.summary;
    const days = rangeDays(meta);
    const groupColumns = (label, keyRender) => [
      {key: 'key', label, value: (r) => String(r.key), render: keyRender},
      {key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
      {key: 'free', label: 'Crash-free', num: true, value: (r) => r.crashFreePct, render: (r) => pct(r.crashFreePct)},
      {key: 'fps', label: 'Median fps', num: true, value: (r) => r.medianFps, render: (r) => fixed(r.medianFps)},
      {key: 'low', label: '1% low', num: true, value: (r) => r.low1Fps, render: (r) => fixed(r.low1Fps)},
      {key: 'stutter', label: 'Stutter', num: true, value: (r) => r.stutterPct, render: (r) => pct(r.stutterPct)},
      {key: 'hitches', label: 'Hitches/min', num: true, value: (r) => r.hitchesPerMin, render: (r) => fixed(r.hitchesPerMin)},
      {key: 'hot', label: 'Hot', num: true, value: (r) => r.hotPct, render: (r) => pct(r.hotPct)},
    ];
    const totalPlay = g.pacing.reduce((a, r) => a + r.play_s, 0) || 1;
    const limitPlay = g.limits.reduce((a, r) => a + r.play_s, 0) || 1;
    const fpsSeries = [
      {name: 'Median', color: cssVar('s1'), values: align(days, g.daily, (r) => r.medianFps)},
      {name: '1% low', color: cssVar('s2'), values: align(days, g.daily, (r) => r.low1Fps)},
    ];
    return [
      head,
      kpis([
        {label: 'Sessions', value: int(sm.sessions), sub: `${hours(sm.playHours)} played`},
        {label: 'Crash-free sessions', value: pct(sm.crashFreePct),
         sub: `${int(sm.crashed)} crashed, ${int(sm.fatal)} fatal, ${int(sm.killed)} killed`},
        {label: 'Median frame rate', value: fixed(sm.medianFps), unit: 'fps', sub: `1% low ${fixed(sm.low1Fps)} fps`},
        {label: 'Stutter', value: pct(sm.stutterPct), sub: 'Time in dropped frames or worse',
         title: 'Time in frames at least 1.5 times the median frame time.'},
        {label: 'Hitches', value: fixed(sm.hitchesPerMin, 2), unit: '/min',
         sub: sm.compilePct === null ? 'Frames over 50 ms' : `${pct(sm.compilePct)} during shader compiles`},
        {label: 'Running hot', value: pct(sm.hotPct), sub: 'Time at Serious or Critical'},
      ]),
      histogramCard(meta, g.histogram),
      h('div', {class: 'grid'},
        card('Frame rate', 'Per day, capped play.',
          lineChart({labels: days, series: fpsSeries, yFormat: (v) => `${Number(v.toFixed(1))}`}),
          {legendFor: fpsSeries, table: () => table([
            {key: 'day', label: 'Day', value: (r) => r.day, render: (r) => longDay(r.day)},
            {key: 's', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
            {key: 'm', label: 'Median fps', num: true, value: (r) => r.medianFps, render: (r) => fixed(r.medianFps)},
            {key: 'l', label: '1% low', num: true, value: (r) => r.low1Fps, render: (r) => fixed(r.low1Fps)},
          ], g.daily.slice().reverse())}),
        card('How sessions ended', null, hbars(g.ends.map((r) => ({label: ENDS[r.key] ?? r.key, value: r.sessions})),
                                              {max: sm.sessions}))),
      card('By device', 'Per chip generation.', h('div', {class: 'scroll'},
        table(groupColumns('Chip', (r) => r.key), g.devices, {sort: {key: 'sessions', dir: 'descending'},
          onRow: (r) => { state.device = r.key; go('games', g.titleId); }}))),
      card('By build', null, h('div', {class: 'scroll'},
        table(groupColumns('Build', (r) => h('span', {class: 'nowrap'}, h('span', {class: 'mono'}, r.key),
          r.official ? null : h('span', {class: 'pill', style: {marginLeft: '8px'}}, 'Self-built'))), g.builds,
          {sort: {key: 'sessions', dir: 'descending'}}))),
      h('div', {class: 'grid'},
        card('Display settings', 'Share of play time.', h('div', {},
          hbars(g.pacing.map((r) => ({label: `Refresh cap: ${PACING[r.key] ?? r.key}`, value: (100 * r.play_s) / totalPlay,
                                      text: pct((100 * r.play_s) / totalPlay)})), {max: 100}),
          h('div', {style: {height: '14px'}}),
          hbars(g.limits.map((r) => ({label: `Frame rate limit: ${r.key ? `${r.key} fps` : 'Off'}`,
                                      value: (100 * r.play_s) / limitPlay, text: pct((100 * r.play_s) / limitPlay)})),
                {max: 100}))),
        card('Memory', 'Per session: the highest footprint, and the least memory iOS had left.', kpis([
          {label: 'Peak footprint', value: mb(g.memory.peakMB?.p50), sub: `Median · 90th percentile ${mb(g.memory.peakMB?.p90)}`},
          {label: 'Least available', value: mb(g.memory.minAvailableMB?.p50), sub: `Median · 10th percentile ${mb(g.memory.minAvailableMB?.p10)}`},
        ])),
        card('Startup and shaders', 'Per session. A first run has no stored shaders yet and compiles them as it plays.', kpis([
          {label: 'First frame', value: secs(g.startup.firstFrameS?.p50),
           sub: `Median · 90th percentile ${secs(g.startup.firstFrameS?.p90)}`,
           title: 'From starting the game to its first frame.'},
          {label: 'Shaders compiled', value: int(g.startup.pipelinesCompiled?.p50),
           sub: `Median · 90th percentile ${int(g.startup.pipelinesCompiled?.p90)}`},
          {label: 'First runs', value: pct(sm.coldPct),
           sub: sm.hitchesPerMinCold === null || sm.hitchesPerMinWarm === null
               ? 'Sessions with no stored shaders'
               : `${fixed(sm.hitchesPerMinCold, 2)} hitches/min, later runs ${fixed(sm.hitchesPerMinWarm, 2)}`},
          {label: 'GPU errors', value: pct(sm.gpuErrorPct), sub: 'Sessions where a GPU command failed'},
        ])),
        card('Crashes in this game', null, g.crashes.length
          ? h('div', {class: 'list'}, g.crashes.map((c) => h('a', {href: href('crashes', c.signature)},
              h('div', {class: 't mono'}, sigText(c.signature)),
              h('div', {class: 'v'}, int(c.reports), h('small', {}, c.reports === 1 ? 'report' : 'reports')),
              h('div', {class: 'm'}, `last ${shortDay(c.lastDay)}`))))
          : empty('No crashes', null))),
    ];
  }

  async function crashes(meta) {
    const d = await api('crashes');
    const days = rangeDays(meta);
    const sessions = d.daily.reduce((a, r) => a + r.sessions, 0);
    const unclean = d.daily.reduce((a, r) => a + r.crashed + r.fatal + r.killed, 0);
    const series = outcomeSeries(days, d.daily, false);
    return [
      pageHead('Crashes', 'One report per launch: the crash reporter’s, else the app’s, else MetricKit’s.'),
      kpis([
        {label: 'Crash-free sessions', value: pct(sessions ? (100 * (sessions - unclean)) / sessions : null),
         sub: `${int(unclean)} of ${int(sessions)} sessions ended badly`},
        {label: 'Crash reports', value: int(d.reports), sub: 'Duplicates of one launch left out'},
        {label: 'Crash groups', value: int(d.groups.length), sub: `${int(d.newGroups)} first seen in this range`},
        {label: 'Devices affected', value: int(d.models), sub: 'Distinct models'},
      ]),
      card('Sessions that ended badly', 'Per day.', barChart({labels: days, series, height: 220}),
           {legendFor: series, table: () => dailyTable(days, d.daily)}),
      card('Crash groups', 'Grouped by the top three XeniOS frames; MetricKit’s are kept apart.', h('div', {class: 'scroll'},
        table([
          {key: 'sig', label: 'Signature', value: (g) => g.signature, render: (g) => h('div', {class: 'sig'},
            g.isNew ? h('span', {class: 'pill new', style: {marginRight: '6px'}}, 'New') : null, sigText(g.signature))},
          {key: 'trend', label: 'Per day', render: (g) => sparkline(g.perDay, days)},
          {key: 'reports', label: 'Reports', num: true, value: (g) => g.reports, render: (g) => int(g.reports)},
          {key: 'models', label: 'Devices', num: true, value: (g) => g.models, render: (g) => int(g.models)},
          {key: 'builds', label: 'Builds', num: true, value: (g) => g.builds, render: (g) => int(g.builds)},
          {key: 'games', label: 'Top game', value: (g) => (g.topGames[0] ? gameName(g.topGames[0]) : ''),
           render: (g) => (g.topGames[0] ? h('span', {class: 'clip muted', title: g.topGames.map(gameName).join(', ')},
             gameName(g.topGames[0]), g.titles > 1 ? h('span', {class: 'faint'}, ` +${g.titles - 1}`) : null) : '–')},
          {key: 'first', label: 'First seen', num: true, value: (g) => g.firstDay, render: (g) => shortDay(g.firstDay)},
          {key: 'last', label: 'Last seen', num: true, value: (g) => g.lastDay, render: (g) => shortDay(g.lastDay)},
          {key: 'issue', label: 'Issue', num: true, value: (g) => g.issueNumber,
           render: (g) => (g.issueNumber ? `#${g.issueNumber}` : '–')},
        ], d.groups, {onRow: (g) => go('crashes', g.signature), sort: {key: 'reports', dir: 'descending'},
                      emptyText: 'No crashes in this range'}))),
    ];
  }

  async function crash(meta, signature) {
    const c = await api('crash', {signature});
    const head = (extra) => pageHead({text: sigText(signature), mono: true}, extra, null, ['Crashes', href('crashes')]);
    if (!c || c.empty) {
      return [head(null), card('No reports in this range', null,
        empty('Nothing to show', c?.firstDay ? `First seen ${longDay(c.firstDay)}. Try a longer range.` : null))];
    }
    const days = rangeDays(meta);
    const perDay = [{name: 'Reports', color: cssVar('s1'), values: align(days, c.daily, (r) => r.reports)}];
    const breakdown = (title, rows, label, link) => card(title, null,
      hbars(rows.map((r) => ({label: label(r), value: r.reports, link: link?.(r)})), {link: !!link}));
    const l = c.latest;
    const isNew = c.firstDay >= meta.since;
    return [
      head([
        h('span', {class: 'pill'}, c.kind),
        isNew ? h('span', {class: 'pill new'}, 'New') : null,
        c.issueNumber ? h('span', {}, `Issue #${c.issueNumber}`) : null,
      ]),
      kpis([
        {label: 'Reports', value: int(c.reports), sub: 'In this range'},
        {label: 'Devices', value: int(c.models), sub: 'Distinct models'},
        {label: 'Builds', value: int(c.builds)},
        {label: 'First seen', value: shortDay(c.firstDay), sub: longDay(c.firstDay)},
        {label: 'Last seen', value: shortDay(c.lastDay), sub: longDay(c.lastDay)},
      ]),
      card('Reports', 'Per day.', barChart({labels: days, series: perDay, height: 180})),
      card('Latest report', [longDay(l.day), l.model, l.os ? `iOS ${l.os}` : null, l.build,
                             SOURCES[l.source] ?? l.source].filter(Boolean).join(' · '),
        h('div', {},
          l.faultAddress ? h('p', {class: 'fact'}, 'Fault address ', h('span', {class: 'mono'}, l.faultAddress)) : null,
          l.message ? h('div', {class: 'fact'}, l.source === 'metrickit' ? 'Termination reason' : 'Message') : null,
          l.message ? h('pre', {class: 'message'}, l.message) : null,
          l.frames.length ? h('div', {class: 'scroll'}, h('table', {class: 'frames'}, h('tbody', {},
            l.frames.map((f, i) => h('tr', {class: f.image === 'XeniOS' ? null : 'dim'},
              h('td', {class: 'num faint'}, i),
              h('td', {class: 'img'}, f.image ?? '?'),
              h('td', {style: {overflowWrap: 'anywhere'}}, f.symbol ?? (f.image === 'XeniOS' ? 'No symbol map for this build' : '')),
              h('td', {class: 'num faint'}, f.offset ?? ''))))))
            : empty('No frames', 'This report carries no stack.'))),
      h('div', {class: 'grid'},
        breakdown('Builds', c.breakdowns.builds, (r) => r.key),
        breakdown('Games', c.breakdowns.games, (r) => (r.key ? gameName({name: r.name, titleId: r.key}) : 'No game'),
                  (r) => (r.key ? href('games', r.key) : null)),
        breakdown('Devices', c.breakdowns.models, (r) => r.key),
        breakdown('iOS versions', c.breakdowns.oses, (r) => (r.key ? `iOS ${r.key}` : 'Unknown')),
        breakdown('Sources', c.breakdowns.sources, (r) => SOURCES[r.key] ?? r.key)),
      card('Recent reports', null, h('div', {class: 'scroll'}, table([
        {key: 'day', label: 'Day', value: (r) => r.day, render: (r) => longDay(r.day)},
        {key: 'game', label: 'Game', value: (r) => r.name ?? r.titleId ?? '',
         render: (r) => (r.titleId ? gameName({name: r.name, titleId: r.titleId}) : '–')},
        {key: 'model', label: 'Device', value: (r) => r.model, render: (r) => r.model},
        {key: 'os', label: 'iOS', value: (r) => r.os ?? '', render: (r) => r.os ?? '–'},
        {key: 'build', label: 'Build', value: (r) => r.build, render: (r) => h('span', {class: 'mono nowrap'}, r.build)},
        {key: 'source', label: 'Source', value: (r) => r.source, render: (r) => SOURCES[r.source] ?? r.source},
      ], c.recent, {sort: {key: 'day', dir: 'descending'}}))),
      c.issueDraft && !c.issueNumber ? card('Issue draft', 'Kept here until the Worker has a GitHub token.',
        h('pre', {class: 'message'}, `${c.issueDraft.title}\n\n${c.issueDraft.body}`)) : null,
    ];
  }

  async function devices() {
    const d = await api('devices');
    const thermal = [
      {key: 'nominal', name: 'Nominal', color: cssVar('t0')},
      {key: 'fair', name: 'Fair', color: cssVar('t1')},
      {key: 'serious', name: 'Serious', color: cssVar('t2')},
      {key: 'critical', name: 'Critical', color: cssVar('t3')},
    ];
    const thermalRows = d.classes.map((c) => {
      const total = thermal.reduce((a, t) => a + (c.thermal[t.key] ?? 0), 0);
      return {c, total};
    }).filter((r) => r.total);
    return [
      pageHead('Devices', 'By chip generation (the model identifier before the comma).'),
      card('Chips', 'Killed: ended by iOS on screen without a crash. Peak memory: the median session’s highest footprint. Least free: the median of the least memory iOS had left.', h('div', {class: 'scroll'}, table([
        {key: 'key', label: 'Chip', value: (r) => r.key, render: (r) => h('b', {}, r.key)},
        {key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
        {key: 'play', label: 'Play time', num: true, value: (r) => r.playHours, render: (r) => hours(r.playHours)},
        {key: 'free', label: 'Crash-free', num: true, value: (r) => r.crashFreePct, render: (r) => pct(r.crashFreePct)},
        {key: 'killed', label: 'Killed', num: true, value: (r) => r.killed, render: (r) => int(r.killed)},
        {key: 'hot', label: 'Hot', num: true, value: (r) => r.hotPct, render: (r) => pct(r.hotPct)},
        {key: 'peak', label: 'Peak memory', num: true, value: (r) => r.footprintMB?.p50,
         render: (r) => h('div', {}, mb(r.footprintMB?.p50),
           h('div', {class: 'faint', style: {fontSize: '11.5px'}}, `p90 ${mb(r.footprintMB?.p90)}`))},
        {key: 'avail', label: 'Least free', num: true, value: (r) => r.availableMB?.p50,
         render: (r) => mb(r.availableMB?.p50)},
        {key: 'warn', label: 'Warnings/h', num: true, value: (r) => r.warningsPerHour,
         render: (r) => fixed(r.warningsPerHour, 2)},
        {key: 'lp', label: 'Low Power', num: true, value: (r) => r.lowPowerPct, render: (r) => pct(r.lowPowerPct)},
      ], d.classes, {sort: {key: 'sessions', dir: 'descending'},
                     onRow: (r) => { state.device = r.key; go('overview'); }}))),
      card('Thermal state', 'Share of session time in each state.',
        thermalRows.length ? h('div', {class: 'stack-rows'}, thermalRows.map(({c, total}) => h('div', {class: 'stack-row'},
          h('b', {}, c.key),
          h('div', {class: 'stack', role: 'img', 'aria-label': thermal.map((t) =>
            `${t.name} ${pct((100 * (c.thermal[t.key] ?? 0)) / total)}`).join(', ')},
            thermal.filter((t) => c.thermal[t.key] > 0).map((t) => h('div', {
              style: {width: `${(100 * c.thermal[t.key]) / total}%`, background: t.color},
              onpointermove: (e) => showTip(e, c.key, thermal.map((x) => [x.color, x.name,
                pct((100 * (c.thermal[x.key] ?? 0)) / total)]), `${hours(total / 3600)} recorded`),
              onpointerleave: hideTip})))))) : empty('No thermal data', null),
        {legendFor: thermal, table: () => table([
          {key: 'key', label: 'Chip', value: (r) => r.c.key, render: (r) => r.c.key},
          ...thermal.map((t) => ({key: t.key, label: t.name, num: true, value: (r) => r.c.thermal[t.key] / r.total,
                                  render: (r) => pct((100 * (r.c.thermal[t.key] ?? 0)) / r.total)})),
        ], thermalRows)}),
      h('div', {class: 'grid'},
        card('Models', null, h('div', {class: 'scroll'}, table([
          {key: 'key', label: 'Model', value: (r) => r.key, render: (r) => r.key},
          {key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
          {key: 'free', label: 'Crash-free', num: true, value: (r) => r.crashFreePct, render: (r) => pct(r.crashFreePct)},
          {key: 'killed', label: 'Killed', num: true, value: (r) => r.killed, render: (r) => int(r.killed)},
          {key: 'hot', label: 'Hot', num: true, value: (r) => r.hotPct, render: (r) => pct(r.hotPct)},
          {key: 'max', label: 'Max memory', num: true, value: (r) => r.maxFootprintMB, render: (r) => mb(r.maxFootprintMB)},
        ], d.models, {sort: {key: 'sessions', dir: 'descending'}}))),
        card('iOS versions', null, h('div', {class: 'scroll'}, table([
          {key: 'key', label: 'Version', value: (r) => r.key, render: (r) => (r.key === 'unknown' ? 'Unknown' : `iOS ${r.key}`)},
          {key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
          {key: 'free', label: 'Crash-free', num: true, value: (r) => r.crashFreePct, render: (r) => pct(r.crashFreePct)},
          {key: 'killed', label: 'Killed', num: true, value: (r) => r.killed, render: (r) => int(r.killed)},
        ], d.oses, {sort: {key: 'sessions', dir: 'descending'}})))),
    ];
  }

  async function builds() {
    const rows = await api('builds');
    return [
      pageHead('Builds', 'Choose one to see everything for that build.'),
      card('All builds', 'Official builds carry the release attestation; self-built ones don’t.', h('div', {class: 'scroll'}, table([
        {key: 'build', label: 'Build', value: (r) => r.lastDay + r.buildId, render: (r) => h('span', {class: 'nowrap'},
          h('span', {class: 'mono'}, r.buildId),
          r.official ? null : h('span', {class: 'pill', style: {marginLeft: '8px'}}, 'Self-built'))},
        {key: 'sessions', label: 'Sessions', num: true, value: (r) => r.sessions, render: (r) => int(r.sessions)},
        {key: 'free', label: 'Crash-free', num: true, value: (r) => r.crashFreePct, render: (r) => pct(r.crashFreePct)},
        {key: 'reports', label: 'Crash reports', num: true, value: (r) => r.crashReports, render: (r) => int(r.crashReports)},
        {key: 'groups', label: 'Groups', num: true, value: (r) => r.crashGroups, render: (r) => int(r.crashGroups)},
        {key: 'killed', label: 'Killed', num: true, value: (r) => r.killed, render: (r) => int(r.killed)},
        {key: 'fps', label: 'Median fps', num: true, value: (r) => r.medianFps, render: (r) => fixed(r.medianFps)},
        {key: 'start', label: 'First frame', num: true, value: (r) => r.firstFrameS, render: (r) => secs(r.firstFrameS)},
        {key: 'gpu', label: 'GPU errors', num: true, value: (r) => r.gpuErrorPct, render: (r) => pct(r.gpuErrorPct)},
        {key: 'play', label: 'Play time', num: true, value: (r) => r.playHours, render: (r) => hours(r.playHours)},
        {key: 'models', label: 'Devices', num: true, value: (r) => r.models, render: (r) => int(r.models)},
        {key: 'titles', label: 'Games', num: true, value: (r) => r.titles, render: (r) => int(r.titles)},
        {key: 'first', label: 'First seen', num: true, value: (r) => r.firstDay, render: (r) => shortDay(r.firstDay)},
        {key: 'last', label: 'Last seen', num: true, value: (r) => r.lastDay, render: (r) => shortDay(r.lastDay)},
      ], rows, {sort: {key: 'build', dir: 'descending'},
                onRow: (r) => { state.build = r.buildId; go('overview'); }}))),
    ];
  }

  function noData(meta) {
    return card('Nothing yet', null, empty('No reports in this range',
      meta.builds.length || state.unofficial ? 'Try a longer range, or clear the build and device filters.'
                                             : 'Only official builds count unless “Include self-built” is on.'));
  }

  function notFound(text, link, label) {
    return card(text, null, h('div', {class: 'empty'}, h('a', {href: link}, `Back to ${label}`)));
  }

  // ---- Shell

  const VIEWS = {overview: 'Overview', games: 'Games', crashes: 'Crashes', devices: 'Devices', builds: 'Builds'};
  let generation = 0;

  function syncControls(meta) {
    for (const b of $('tabs').querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.view === (state.parts[0] in VIEWS ? state.parts[0] : 'overview')));
    }
    for (const b of $('range').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.days));
    }
    $('unofficial').checked = state.unofficial;
    const fill = (select, all, items, selected) => {
      const options = [h('option', {value: ''}, all), ...items.map(([value, label]) =>
        h('option', {value}, label))];
      if (selected && !items.some(([value]) => value === selected)) {
        options.push(h('option', {value: selected}, `${selected} (no data)`));
      }
      select.replaceChildren(...options);
      select.value = selected;
    };
    fill($('build'), 'All builds', meta.builds.map((b) =>
      [b.build_id, `${b.build_id}${b.official ? '' : ' (self-built)'}`]), state.build);
    fill($('device'), 'All devices', meta.devices.map((d) => [d.device_class, d.device_class]), state.device);
    const label = $('label');
    label.hidden = !meta.label;
    label.textContent = meta.label ? `⚠︎ ${meta.label}` : '';
    $('scope').textContent = [
      state.unofficial ? 'Official and self-built builds' : 'Official builds',
      state.build || null, state.device || null,
      `${shortDay(meta.since)} – ${shortDay(meta.today)}`,
    ].filter(Boolean).join(' · ');
  }

  async function render() {
    readHash();
    const gen = ++generation;
    const main = $('main');
    const content = $('content');
    main.setAttribute('aria-busy', 'true');
    hideTip();
    try {
      const meta = await api('meta');
      if (gen !== generation) return;
      syncControls(meta);
      const [view, item] = state.parts;
      const name = view in VIEWS ? view : 'overview';
      const nodes = name === 'games' && item ? await game(meta, item)
                  : name === 'crashes' && item ? await crash(meta, item)
                  : await {overview, games, crashes, devices, builds}[name](meta);
      if (gen !== generation) return;
      document.title = `${item && name === 'games' ? 'Game' : item ? 'Crash' : VIEWS[name]} · XeniOS Diagnostics`;
      content.replaceChildren(...nodes.flat().filter(Boolean));
      if (content.dataset.view !== `${name}/${item ?? ''}`) scrollTo({top: 0});
      content.dataset.view = `${name}/${item ?? ''}`;
    } catch (error) {
      if (gen !== generation) return;
      content.replaceChildren(card('Couldn’t load the data', null, h('div', {class: 'empty'},
        h('div', {}, String(error.message ?? error)),
        h('button', {class: 'toggle', type: 'button', onclick: () => { cache.clear(); render(); }}, 'Try Again'))));
    } finally {
      if (gen === generation) main.removeAttribute('aria-busy');
    }
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) go(b.dataset.view);
  });
  $('range').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.days = Number(b.dataset.days);
    go(...state.parts);
  });
  $('unofficial').addEventListener('change', (e) => {
    state.unofficial = e.target.checked;
    go(...state.parts);
  });
  $('build').addEventListener('change', (e) => { state.build = e.target.value; go(...state.parts); });
  $('device').addEventListener('change', (e) => { state.device = e.target.value; go(...state.parts); });
  addEventListener('hashchange', render);
  addEventListener('scroll', hideTip, {passive: true});
  render();
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>XeniOS Diagnostics</title>
<style>${CSS}</style></head>
<body>
<header class="wrap hero">
  <p class="eyebrow">XeniOS</p>
  <div class="title-row"><h1>Diagnostics</h1><span id="label" class="note-badge" hidden></span></div>
  <p class="lede" id="scope">Crash reports and performance statistics from players’ devices.</p>
</header>
<div class="bar"><div class="wrap">
  <div class="seg" id="tabs" role="tablist" aria-label="Views">
    <button type="button" role="tab" data-view="overview">Overview</button>
    <button type="button" role="tab" data-view="games">Games</button>
    <button type="button" role="tab" data-view="crashes">Crashes</button>
    <button type="button" role="tab" data-view="devices">Devices</button>
    <button type="button" role="tab" data-view="builds">Builds</button>
  </div>
  <div class="filters">
    <div class="seg" id="range" aria-label="Range">
      <button type="button" data-days="7">7 Days</button>
      <button type="button" data-days="30">30 Days</button>
      <button type="button" data-days="90">90 Days</button>
    </div>
    <label class="pick"><span>Build</span><select id="build"></select></label>
    <label class="pick"><span>Device</span><select id="device"></select></label>
    <label class="switch"><input type="checkbox" id="unofficial"><span></span>Include self-built</label>
  </div>
</div></div>
<main class="wrap" id="main" aria-busy="true"><div class="content" id="content">
  <div class="kpis"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
</div></main>
<footer class="wrap">Anonymous records from XeniOS with Share Diagnostics on. A session is one game from start to stop.
Frame rates are guest frames during capped play; crash counts keep one report per launch. Raw records are kept 90 days.</footer>
<div id="tip" role="tooltip" hidden></div>
<script>(${app.toString()})();</script>
</body></html>`;
