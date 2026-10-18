# 全部依赖升级实施计划

> 使用 superpowers:executing-plans 在当前工作目录连续执行；不提交 Git、不推送、不生成安装包。

**目标：** 将项目直接依赖升级至本轮核对的最新稳定版，保留原有功能，完成测试和 Windows x64 Release EXE 编译。

**架构：** 保持现有 Tauri、Next.js、平台适配器和播放器结构。只修改依赖声明、锁文件、必要的兼容调用及构建环境。

**技术栈：** Tauri 2、Next.js 16、React 19、TypeScript、Rust、xgplayer。

**需求：** 用户要求“全部更新”；本地升级清单位于 E:/2/DTV/build-tools/dependency-audit.json。

## 约束与复核重点

- 不恢复已断开的更新源；不增加功能，不自动提交 GitHub，不生成安装包。
- Tauri 插件的 npm 与 Cargo 版本一致。
- 最新稳定版低于已用预发布版时，不冒充升级；记录实际处理方式。
- 保留 TARS 所需的 bytes 0.4 类型兼容；不改写正常工作的协议。
- 抖音定制弹幕、四平台直播取流、HTTP 长连接、搜索跳转、D/F 键和窗口配置必须通过验证。
- TypeScript 编译器与测试使用的程序 API、Next.js 构建都必须能运行。

## 执行步骤

- [x] 备份原配置和定制弹幕库，核对最新版包的元数据、接口和迁移说明。
- [x] 升级 npm 直接依赖、安装并更新 pnpm 锁文件，运行前端测试与类型检查，修复兼容差异。
- [x] 升级 Cargo 直接依赖并更新锁文件，配置匹配的 V8 静态库，执行 cargo check，按实际诊断迁移接口。
- [x] 运行完整前端与 Rust 测试，检查差异及依赖版本，修复发现的问题。
- [x] 执行 pnpm tauri build --no-bundle，验证 EXE 及运行依赖，确认没有生成安装包或提交 Git。

## 执行记录

- 2026-10-05：开始执行，工作区干净，已有 38 项前端、45 项 Rust 回归测试。原构建环境 Node 22.23.3、pnpm 9.15.9、Rust nightly 1.99.0。
- 前端 40 项测试及 TypeScript 7 类型检查通过，Next.js 16.3.8 静态导出通过；Rust 48 项 Release 测试通过，包括真实抖音 sign.js、斗鱼 CryptoJS 和持续 23 秒直播连接。
- 决策：沿用 Specta 2.0 预发布分支并升级至 rc.25，避免降级到 1.0；TARS 的 bytes04 保留 0.4.12；测试专用 TypeScript 程序 API 使用该 API 最后稳定分支 6.0.3，正式编译器使用 7.0.2。
- 决策：旧弹幕库的 trackAllocationOptimization 在本项目从未启用，不迁移其未使用分支；真实新版引擎与项目包装层的开关、配置、三类队列和清理回归通过，密度限流保持原实现。
- 运行中的旧版 EXE 已移动到构建工具目录，未中断用户进程；正式构建使用 --no-bundle。
- 最终独立只读审查未发现重大回归或升级遗漏；官方注册表复核 85 项依赖声明全部匹配目标版本（包含上述兼容分支）。
- 正式 Release 编译成功：E:/2/DTV/dtv_x-main/src-tauri/target/release/dtv_x.exe，59,147,776 字节，Windows GUI x64，版本 0.2.10，SHA256 A1F16711FFC6F712743CACEF1D078CB298D53AEC8538D76F29A8034F78BD5FA0；导入依赖为系统 DLL。
- 最终前端 40/40 通过；Git diff --check 通过。Git HEAD 仍为 dc838267060d8d274ba586964c9b3896f024448c，未提交或推送；原安装包时间仍为 2026-10-05 22:57:26，未重新打包。
- 验证范围：已验证源码、协议回归、签名、前端静态构建和 PE 产物；未中断旧版正在运行的直播，未宣称真实平台在线播放已实测。
