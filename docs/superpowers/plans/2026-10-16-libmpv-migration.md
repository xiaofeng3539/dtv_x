# libmpv Playback Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 保持 DTV UI 与原有功能，完整迁移 Simple Live 播放链路和 libmpv 内核。

**Architecture:** Rust 拥有常驻原生播放器；前端控件通过适配层控制。先用独立窗口验证原生画面与 WebView 叠加，验证通过才正式接入。

**Tech Stack:** React/Next.js、Rust/Tauri 2、Windows/WebView2、libmpv C API。

**Spec:** `E:/2/DTV/dtv_x-main/docs/superpowers/specs/2026-10-16-libmpv-migration-design.md`

## Global Constraints

- UI、原功能、五个平台及托盘播放规则不变。
- Simple Live 只读，保留全部既有未提交修改。
- 改写前备份、原子替换；不发布、不覆盖安装。
- 不用外置播放器或画面转码代替原生内核接入。
- 必须实际编译和打包，未完成项目明确报告。

## Review Focus

- 原生视频的窗口层级不得遮挡 HTML 控件和弹幕。
- 旧媒体异步事件不得清掉新房间的画面、音频或状态。
- 停止和打开必须串行；不能在 UI 线程同步等待解码线程。
- 缺 DLL、错误架构或导出符号必须明确报错，不静默返回旧内核。
- 画中画与托盘行为必须保留，不能只验收普通窗口。

## Task 1: 原生输出兼容性探针

**Files:** `src-tauri/examples/native_surface_probe.rs`、独立探针配置；探针日志保存到项目外 build-tools。

- [ ] 读取实际 libmpv 头文件和 media_kit Windows 输出实现，记录版本和依赖。
- [ ] 用原生 libmpv 打开确定性本地媒体，在独立透明 WebView 窗口覆盖 HTML 控件与弹幕。
- [ ] 验证画面、叠加、尺寸同步和关闭；失败保留证据并停止正式启用。

## Task 2: 原生播放器服务

**Files:** 新增 `src-tauri/src/native_player/`；接入 `src-tauri/src/main.rs`，必要时修改打包资源配置。

**Interfaces:** `open(media, generation)`、`stop(generation)`、`set_pause`、`set_volume`、`set_muted`；事件携带 generation、playing/buffering/position/end/error。

- [ ] 先写真实 DLL 加载、符号/版本、初始化失败、串行代次与关闭测试并观察失败。
- [ ] 实现动态加载、独立事件线程、串行媒体命令及窗口输出。
- [ ] 验证请求头逐媒体绑定、8 秒缓存、10 秒网络超时、停止后资源释放。

## Task 3: 前端播放器适配

**Files:** 新增播放器适配模块；修改 `web/src/components/player/MainPlayer.tsx` 和必要的播放区样式，不改变可见布局。

- [ ] 先写原 UI 控件契约和过期事件隔离测试。
- [ ] 实现原生事件到现有控件的状态适配，保留弹幕、快捷键、全屏和画中画。
- [ ] 验证 DPI/窗口变化、托盘后台播放、关闭释放与快速切台。

## Task 4: 平台拉流与调度对齐

**Files:** 各平台现有取流 Rust 文件与 playerHelper；不修改搜索、登录、关注分类查询。

- [ ] 对照四个 Site 写有效/缺失/错误响应和候选线路测试。
- [ ] 移植画质、候选 URL 和 headers，保留 DTV Twitch 查询并接入原生媒体。
- [ ] 实现 3 秒错误复核、15 秒缓冲检查、备用线路优先和限次恢复。

## Task 5: 回归与安装包

- [ ] 检查本轮差异与无关修改保留情况。
- [ ] 运行 TypeScript、全套前端测试、Rust check/test。
- [ ] 执行确定性原生播放和 UI 功能验证，报告真实平台联机限制。
- [ ] Windows Release 与 NSIS 完整打包，核验运行依赖、版本、架构、载荷及哈希。
- [ ] 只在以上必需验收通过时报告全量迁移完成。
