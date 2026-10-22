<div align="center">

# 📺 DTV_X

**Windows 多平台直播聚合客户端**

斗鱼 · 虎牙 · 抖音 · 哔哩哔哩 · Twitch

[![Release](https://img.shields.io/github/v/release/xiaofeng3539/dtv_x?style=flat-square&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/xiaofeng3539/dtv_x/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-brightgreen?style=flat-square)](https://github.com/xiaofeng3539/dtv_x/releases)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri)](https://tauri.app/)
[![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)](LICENSE)

[下载安装](#-下载安装) · [功能一览](#-功能一览) · [常见问题](#-常见问题) · [自行构建](#-自行构建)

基于 React / Next.js 与 Rust / Tauri 2，Windows 使用内置 libmpv 播放直播，保留原有界面、弹幕和播放控件。

</div>

> 当前维护仓库：[xiaofeng3539/dtv_x](https://github.com/xiaofeng3539/dtv_x)
>
> 项目来源：[cookie-kangd/dtv_x](https://github.com/cookie-kangd/dtv_x) · 上游：[chen-zeong/DTV](https://github.com/chen-zeong/DTV)
>
> 分类与播放链路参考：[Simple Live](https://github.com/xiaoyaocz/dart_simple_live)，保留 DTV 的前端界面及原有功能，并非直接运行 Flutter / Dart 代码。

---

## 📥 下载安装

当前程序版本：**0.1.0**；最新修复发布：**v0.1.0-fix.20261022**。前往 [Releases](https://github.com/xiaofeng3539/dtv_x/releases/latest)，在 **Assets** 中选择一种安装包：

- `DTV_X_0.1.0_x64-setup.exe`：NSIS 安装包。
- `DTV_X_0.1.0_x64_zh-CN.msi`：MSI 安装包。

发布页提供完整 Windows 安装包与 `SHA256SUMS.txt` 校验文件，EXE 与 MSI 二选一。源码 ZIP / tar.gz 不是可直接运行的 Windows 安装包。

- **系统要求**：Windows 10 / 11 x64，需有 Microsoft Edge WebView2 Runtime；安装器包含相应先决条件处理。
- **原生播放依赖**：安装包内含 `libmpv-2.dll` 及第三方许可证，不需要另装 mpv 或 Flutter。
- **更新方式**：从本仓库 Releases 手动下载。应用内更新入口已移除，不再从上游仓库检查或下载更新。
- **数据迁移**：支持关注数据导入、导出与局域网同步；覆盖安装和旧版本降级安装未在本次发布中实测。
- **签名状态**：v0.1.0 的 Windows 安装包未进行代码签名。

详细变更见 [最新修复 Release](https://github.com/xiaofeng3539/dtv_x/releases/tag/v0.1.0-fix.20261022) 和 [更新说明](RELEASE_NOTES.md)。

---

## ✨ 功能一览

### 🎬 直播聚合

- **五个平台**：斗鱼、虎牙、抖音、哔哩哔哩、Twitch。
- **浏览与搜索**：保留现有平台分区、主播搜索和房间链接跳转入口，各平台能力以当前接口支持为准。
- **关注管理**：关注 / 取消关注、手动文件夹、拖动排序与自动游戏分组。

### 🗂 关注按游戏／直播分区分组

- 在关注侧栏和展开的关注面板中切换 **文件夹 / 游戏分组**；默认保留文件夹模式，选择后记住设置。
- 相同游戏或分区的主播跨平台集中显示，支持 LOL / League of Legends → 英雄联盟等明确别名统一。
- 分类来自平台官方元数据，不根据主播昵称或直播标题猜测；未开播时也可使用官方分类或已有缓存。
- 查询失败或未返回有效分类时保留旧分类；没有有效分类或缓存的主播归入 **其他**。
- 支持平台与 **全部 / 直播中 / 未开播** 筛选；未知状态仅在“全部”中显示。
- 分类标题显示 **分类名称 + 当前筛选后人数**；分类按直播人数降序，“其他”始终最后。
- 组内先按平台顺序，再按同平台热度降序；未知热度靠后，同条件保持稳定顺序，不比较不同平台的热度数值。
- 游戏分组只是显示视图，不修改手动文件夹归属和原有手动顺序，也不启用文件夹拖动逻辑。
- 分类缓存随关注数据保存，并在导入、导出及同步中保留；直播状态和热度只在本次运行有效，不持久化或同步。
- 进入直播间、全屏及退出全屏后，保留已选的平台和直播状态筛选。

### 🔄 关注刷新规则

刷新调度与状态生命周期按本地参考项目 Simple Live 的 FollowService / FollowUser 对齐：

- **状态仅本次运行有效**：冷启动统一为“未知”，不恢复昨天保存的直播状态；关注关系、分类缓存及手动顺序照常保留。
- **启动立即校验**：关注数据及设置就绪后立即查询，不等待侧栏空闲。
- **全量刷新**：手动和定时刷新均校验全部关注，同时发现开播与下播，不受显示筛选限制。
- **固定 worker + 平台交错队列**：自动并发为 CPU 核心数 × 2.5 四舍五入，限制为 4–20；设置中也可手动指定 1–20。
- **结果发布时机**：新开播或分类变更及时发布，其余结果在本轮结束时合并发布，完成后结束刷新进度。
- **失败显示未知**：单个请求失败不会中断整轮，也不会继续把旧状态显示为“直播中”；清除过期热度但保留有效分类，下一轮可重试。
- **全局服务调度**：全屏、关闭侧栏或切换页面不销毁刷新任务与计时器。新用户默认开启 10 分钟轮询，已有设置保留；设置为“关闭”后仍可手动刷新。
- **DTV 适配**：复用现有平台元数据响应，不额外请求播放地址；保留超时、防重复刷新及旧轮次隔离保护，不将自动排序写入手动文件夹。

### 🛠 本次修复

- 虎牙楚河、天天等使用房间别名的关注，播放与关注刷新共用官方数字房号解析和成功缓存；无需重新关注。
- 补齐抖音访客会话、动态签名、弹幕握手、心跳及 ACK，保留真实接口错误。
- 修复切台时旧暂停状态和请求干扰，以及设置面板点击层级。

### 🎞 播放体验

- **内置 libmpv**：Windows 原生播放内核，界面和弹幕仍由现有前端提供。
- **取流与切换**：复用候选线路与元数据，隔离旧房间请求及事件，改进房间切换和加载恢复。
- **原有操作保留**：画质切换、全屏、音量、静音、弹幕开关、画中画与托盘播放。
- **窗口修复**：处理画面重叠、重复标题栏和全屏黑屏问题。

### 💬 弹幕与其它功能

- 各平台现有实时弹幕接入、纯净聊天弹幕显示。
- 明暗主题切换。
- 关注数据 JSON 导入 / 导出及局域网同步。

---

## ❓ 常见问题

<details>
<summary><b>关注中未开播的主播为什么仍能按游戏分类？</b></summary>

平台在未开播时仍可能返回官方分类；没有有效新分类时继续使用之前保存的分类缓存。两者都不存在时才显示在“其他”，不会通过昵称或标题猜测。
</details>

<details>
<summary><b>主播下播后为什么还显示“直播中”？</b></summary>

旧版曾永久跳过“直播中”的缓存；当前源码按 Simple Live 的状态生命周期处理：启动先为“未知”，查询成功再确认开播或下播；查询失败回到“未知”，不沿用昨天的直播状态。可手动刷新，或开启关注轮询。
</details>

<details>
<summary><b>还需要安装系统 HEVC 视频扩展吗？</b></summary>

Windows 版已使用内置 libmpv，不再把系统 WebView 的 HEVC 视频扩展作为原生播放的前提。若播放失败，应结合具体平台、线路和错误信息排查；硬件解码能力仍受设备及驱动影响。
</details>

<details>
<summary><b>某个平台打不开或触发验证码？</b></summary>

直播平台接口、登录状态、访问限制和网络环境都可能影响播放或搜索。可重新进入直播间或切换可用画质 / 线路；接口变动需等待后续版本适配。
</details>

<details>
<summary><b>关注数据怎么迁移？</b></summary>

使用应用内数据同步功能：同一局域网内可同步，也可以导出 JSON 后在另一台设备导入。游戏分类缓存一并保留；直播状态和热度属于本次运行的数据，不写入导出文件。
</details>

<details>
<summary><b>如何获取更新？</b></summary>

前往本仓库 Releases 手动下载。没有应用内自动更新入口，也不会跳转上游仓库下载更新。
</details>

---

## 🛠 自行构建

### Windows 环境

- Node.js **22+**、pnpm **9**；v0.1.0 本地验证使用 Node.js 22.23.3 / pnpm 9.15.9。
- Rust / rustup，使用 `src-tauri/rust-toolchain.toml` 声明的 **nightly** 工具链。
- Visual Studio C++ x64 构建工具和 Windows SDK。
- Protocol Buffers 编译器 `protoc`，加入 `PATH` 或设置 `PROTOC` 环境变量。
- WebView2 Runtime，用于应用界面。
- `src-tauri/resources/libmpv/` 中的原生 DLL 与许可证必须保留，正式安装包会自动包含这些资源。

以下命令在 PowerShell 中执行：

```powershell
# 克隆并安装锁定依赖
git clone https://github.com/xiaofeng3539/dtv_x.git
cd dtv_x
pnpm install --frozen-lockfile

# 开发调试
pnpm tauri dev
```

检查与测试：

```powershell
pnpm -C web exec tsc --noEmit --incremental false
node --test web/tests/*.test.cjs

# 从 src-tauri 目录运行，以使用项目声明的 Rust 工具链
cd src-tauri
cargo test --locked
cd ..
```

真实 libmpv 解码集成用例需要额外提供 `DTV_TEST_MPV` 和 `DTV_TEST_MEDIA`（确定性的本地测试视频），默认部分用例会跳过；普通单元测试不需要这些本地测试素材。

Windows Release 及完整安装包：

```powershell
pnpm tauri build --bundles nsis,msi --ci -- --locked
```

默认产物位于：

- `src-tauri/target/release/bundle/nsis/`
- `src-tauri/target/release/bundle/msi/`

如果设置了 `CARGO_TARGET_DIR`，产物位于该目录下的 `release/bundle/`。工作流仅保留手动触发入口，推送 Tag 不会自动构建或上传安装包。

### v0.1.0-fix.20261022 已执行验证

- TypeScript 静态检查通过。
- 前端测试 **158 项通过**。
- Rust 主测试 **96 项通过**，**2 项既有联网测试跳过**。
- libmpv 集成测试显式运行 **7 项，全部通过**。
- Windows x64 Release、NSIS 与 MSI 打包成功；安装包解包、程序版本、DLL、许可证、完整性及 SHA-256 校验通过。
- 未执行覆盖安装及所有平台长期联机、跨 GPU / 混合 DPI 测试。

以上为当前修复发布对应的验证记录，不代表每次启动都会自动执行这些检查。楚河／天天已完成从关注列表进入的真实取流解码、6 次切台及 45 秒连续播放验证；这是本次网络测量，不等于所有平台长期或所有 GPU 的可视画面验收。抖音 HTTP 444 重启后未复现，尚未确认长期问题已根治。

---

## 🧱 技术栈

| 类别 | 选型 |
|---|---|
| 桌面框架 | Tauri 2 / Rust / WebView2（Windows 界面） |
| 前端 | Next.js / React / TypeScript |
| Windows 播放 | libmpv 动态库，前端控件通过原生接口控制 |
| 异步与网络 | tokio / reqwest / tokio-tungstenite |
| 弹幕协议 | WebSocket / protobuf 等平台协议 |
| JS 引擎 | deno_core，用于平台签名算法 |

---

## 📄 许可与致谢

- 保留项目原有 [MIT LICENSE](LICENSE) 和原作者署名。
- libmpv、FFmpeg 及参考项目 Simple Live 的许可证、来源与版本说明见 [第三方声明](src-tauri/resources/libmpv/licenses/THIRD-PARTY-NOTICES.txt) 和 [许可证目录](src-tauri/resources/libmpv/licenses/)。第三方组件遵循各自许可证。
- 感谢 DTV、dtv_x 与 Simple Live 项目提供的基础与参考实现。
- 本项目不是任何直播平台的官方客户端，与哔哩哔哩、斗鱼、虎牙、抖音及 Twitch 无官方关联。直播内容及相关权利归原权利人所有。
