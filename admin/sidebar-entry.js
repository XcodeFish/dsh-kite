/**
 * dsh-kite 浏览器半包（dsh.client web 半）：把「手机远程」入口注册进左侧栏底部槽位。
 *
 * 为什么是槽位而不是 DOM 拼接（2026-10-02 源码实证）：
 *   `sidebar.footer.action` 是 client-ui-sidebar 声明的 **list 槽**，渲染在
 *   `.footerActions` 里、紧贴 Settings 行上方。官方 client-ui-cordis（order 0）
 *   与 dsh-context「上下文洞察」（order 10）都注册在这里。list 槽按
 *   priority → order 升序渲染，所以本插件用 order 20 即落在上下文洞察**下方**、
 *   Settings 上方；改 order 5 即落在其上方。位置由框架保证，不依赖 CSS 硬凑，
 *   也不受 React 重渲染影响（DOM 拼接的固有缺陷）。
 *
 * 与宿主半的关系：
 *   浮层本体与认证逻辑仍归 admin/panel-client.js（真机验证过的唯一可靠通道：
 *   父上下文 fetch + 主页内原生 DOM 浮层）。本文件只负责**入口**，点击时调用
 *   panel-client 暴露的 `window.__DSH_KITE_OPEN__`；该全局尚未就绪或未注入时，
 *   退化为点击右下角悬浮按钮；两者都不可用则保持静默（绝不顶层导航 —— 那会 401 白页）。
 *
 * 形态约束（勿改）：
 *   本文件是**经典脚本**（无 import/export），由 dsh-client-modules 经 <script> 直接
 *   执行，因此必须自行调用 `window.__ModuleLoader__.load({ id: <包名>, factory })`。
 *   注册 id 必须是**包名** `dsh-kite`：宿主侧 graph row 的 id 取自 Loader 行的包名，
 *   arrive() 校验的正是它，写错会报 "loaded without registering"。
 *   `require("react")` 可用 —— react / react-dom / react/jsx-runtime 与
 *   @deepseek-ai/dsh-client-ui-primitives 都是平台 seed 模块（静态模块表），
 *   无需在 dsh.client.external 里声明。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kite',
  factory(require) {
    'use strict';

    /** 槽位名与注册 id（list 槽必须给 id；重复注册同 id 同 priority 会抛错）。 */
    var SLOT = 'sidebar.footer.action';
    var ENTRY_ID = 'kite-entry';
    /**
     * 渲染序：Cordis Plugin = 0，上下文洞察 = 10。
     * 20 → 上下文洞察下方；改 5 → 其上方。priority 保持默认 0。
     */
    var ENTRY_ORDER = 20;
    var STYLE_ID = 'dsh-kite-sidebar-style';

    /**
     * 面板打开函数。三级回退，任何一级缺失都不抛错：
     *   ① panel-client 暴露的全局（首选，含认证与浮层装配）
     *   ② 右下角悬浮按钮的 click()（与 ① 等价，只是多一跳）
     *   ③ 静默 —— 绝不 location.href 顶层导航（webview 不带宿主 cookie → 401 白页）
     */
    function openPanel() {
      try {
        if (typeof window.__DSH_KITE_OPEN__ === 'function') {
          window.__DSH_KITE_OPEN__();
          return;
        }
        var floating = document.getElementById('dsh-ra-menu-entry');
        if (floating) {
          floating.click();
          return;
        }
      } catch (error) {
        /* 入口失败绝不影响 GUI */
      }
    }

    /** 侧栏入口的样式：几何完全对齐「上下文洞察」条目，收起态退化为 36px 圆形图标。 */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.dsh-kite-entry{box-sizing:border-box;width:calc(100% + 4px);height:42px;',
        'color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;',
        'border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;',
        'font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}',
        '.dsh-kite-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsh-kite-entry:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
        '.dsh-kite-entry-rail{border-radius:50%;flex:none;justify-content:center;gap:0;',
        'width:36px;height:36px;margin:0;padding:0}',
        '.dsh-kite-entry-icon{flex:none}',
        '.dsh-kite-entry-label{text-align:left;white-space:nowrap;text-overflow:ellipsis;',
        'flex:auto;min-width:0;overflow:hidden}'
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    }

    /** 手机图标（与右下角悬浮按钮同形，视觉一致）。 */
    function PhoneIcon(props) {
      return require('react').createElement(
        'svg',
        {
          className: 'dsh-kite-entry-icon',
          width: props.size,
          height: props.size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          'aria-hidden': 'true'
        },
        require('react').createElement('rect', { x: 7, y: 2, width: 10, height: 20, rx: 2 }),
        require('react').createElement('line', { x1: 11, y1: 18, x2: 13, y2: 18 })
      );
    }

    /**
     * 槽位组件。ownerProps 只带 `wide`（侧栏展开 = true，收起成 56px rail = false）。
     * 收起态只渲染图标并自带 aria-label，保证图标态仍可被读屏与 tooltip 定位。
     */
    function KiteEntry(props) {
      var react = require('react');
      var wide = props.wide === true;
      return react.createElement(
        'button',
        {
          type: 'button',
          className: wide ? 'dsh-kite-entry' : 'dsh-kite-entry dsh-kite-entry-rail',
          title: '手机远程访问（扫码连接）',
          'aria-label': '手机远程访问',
          onClick: openPanel
        },
        react.createElement(PhoneIcon, { size: wide ? 16 : 18 }),
        wide ? react.createElement('span', { className: 'dsh-kite-entry-label' }, '手机远程') : null
      );
    }

    function apply(ctx) {
      try {
        ensureStyle();
      } catch (error) {
        /* 样式失败不阻断注册：按钮仍可用，只是退回无样式 */
      }
      // slots.inject 是懒注册：槽位未声明时回调不执行，声明后自动执行并在卸载时清理。
      // 因此本插件不依赖与 client-ui-sidebar 的加载顺序。
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER },
          KiteEntry
        );
      });
    }

    return {
      name: 'dsh-kite',
      // 只需 slots 服务；不声明 locale —— 文案是写死的中文，少一个注入点就少一处失败面。
      inject: ['slots'],
      apply: apply
    };
  }
});
