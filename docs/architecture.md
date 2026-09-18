# Frank 架构与开发运行说明

> 本文用于维护 Frank 的前端、Tauri/Rust 后端、窗口和开发启动方式。

## 1. 总体结构

Frank 是一个 Tauri 2 桌面应用。项目在职责上分为前端和后端，但开发时不应把它理解成两个需要分别手动启动的网络服务。

```text
Vite / Node.js（仅开发环境）
        │  http://localhost:1420、HMR
        ▼
Tauri / Frank.exe（Rust 宿主与后端）
        │  Tauri IPC：invoke / emit
        ▼
Vue WebView 页面
        │  HTTP / WebSocket
        ▼
League Client（LCU 服务）
```

开发时通常可以观察到以下进程：

| 进程或运行时 | 是否只在开发环境存在 | 主要职责 |
| --- | --- | --- |
| Vite / Node.js | 是 | 提供前端页面、TypeScript/Vue 构建和热更新，监听 `http://localhost:1420` |
| Tauri CLI | 是 | 启动 `pnpm dev`、编译并运行 Rust 应用，负责开发编排 |
| `Frank.exe` | 否 | Tauri 宿主、Rust 后端、系统能力和 LCU 通信 |
| WebView2 | 否 | 在桌面窗口中渲染 Vue 页面；具体实现可能包含 WebView2 子进程 |
| League Client | 外部程序 | 提供 Frank 使用的 LCU REST/WebSocket 接口 |

生产环境不会启动 Vite。前端先构建到 `dist`，然后由 `Frank.exe` 加载；WebView2 仍负责渲染页面。

## 2. 前端职责

前端代码位于 `src/`，负责：

- Vue 页面、组件、交互和状态管理；
- 主界面、查询战绩、战绩分析和最近对局等窗口；
- 通过 `invoke()` 调用 Rust 命令；
- 通过 Tauri 事件接收客户端启动、游戏流程等状态变化；
- 在隐藏的 `background` 页面中协调监听、快捷键和窗口创建。

`background` 不是 Rust 后端服务，而是一个隐藏的 Vue/WebView 页面。它负责在前端侧维持后台逻辑，并调用 Rust 后端。

主要入口：

- `src/background/background.ts`：后台页面的事件和游戏流程协调；
- `src/background/utils/creatWindow.ts`：创建和管理 Tauri WebView 窗口；
- `src/main/`：主界面；
- `src/queryMatch/`：查询对局界面；
- `src/matchAnalysis/`：战绩分析界面；
- `src/recentMatch/`：最近对局界面。

## 3. Tauri 窗口模型

Tauri 配置中的 `background` 是初始隐藏窗口。后台页面随后通过 `WebviewWindow` 创建其他页面：

| 窗口标签 | 页面 | 用途 |
| --- | --- | --- |
| `background` | `src/background/index.html` | 隐藏后台协调页面 |
| `mainWindow` | `src/main/index.html` | 主界面 |
| `queryMatchWindow` | `src/queryMatch/index.html` | 查询对局 |
| `matchAnalysisWindow` | `src/matchAnalysis/index.html` | 战绩分析 |
| `recentMatchWindow` | `src/recentMatch/index.html` | 最近对局 |

这些页面是多个前端 WebView 窗口，不是多个独立的 Rust 后端服务。它们共享同一个 `Frank.exe` 进程中的 Tauri/Rust 后端状态。

相关代码：

- `src-tauri/tauri.conf.json`：声明初始窗口和开发前端地址；
- `src/background/utils/creatWindow.ts`：创建窗口；
- `src-tauri/src/lib.rs`：注册窗口插件、状态和 Tauri commands。

## 4. Rust 后端职责

Rust 代码位于 `src-tauri/src/`，由 `Frank.exe` 承载，主要负责：

- 读取 `LeagueClientUx.exe` 的启动参数，获取 LCU 端口、Token 和区域；
- 通过 LCU REST/WebSocket 接口查询召唤师、对局和游戏状态；
- 监听 League Client 启动以及游戏流程事件；
- 监听全局键盘事件；
- 查找并跟踪 LOL 窗口位置，调整 Frank 窗口停靠位置；
- 启动 LOL；
- 读取和修改游戏配置，例如窗口模式；
- 管理跨窗口共享状态，并把事件发送回前端。

Rust 后端本身不是一个单独监听 HTTP 端口的 Web 服务。前端通过 Tauri IPC 调用 Rust commands，Rust 再访问 League Client 的 LCU 服务。

主要实现：

- `src-tauri/src/lib.rs`：应用入口、共享状态、commands 和插件注册；
- `src-tauri/src/lcu.rs`：LCU 通信、客户端监听、游戏流程和配置操作；
- `src-tauri/src/shaco/utils/process_info.rs`：读取 League Client 进程参数；
- `src-tauri/src/lol_window_tracker.rs`：LOL 窗口跟踪和停靠。

## 5. 前后端通信

前端调用 Rust 的典型路径是：

```text
Vue 页面
  └─ invoke("invoke_lcu", ...)
       └─ Tauri IPC
            └─ Rust command
                 └─ LCU REST / WebSocket
```

Rust 侧使用 `#[tauri::command]` 暴露命令，并在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册。Rust 侧还可以通过 `emit`/`emit_to` 向指定 WebView 页面发送事件。

## 6. 开发启动方式

### 推荐：同时启动前端和后端

```powershell
.\.vscode\tauri-msvc.cmd tauri dev
```

`src-tauri/tauri.conf.json` 中的 `beforeDevCommand` 会自动执行 `pnpm dev`，因此不需要另外打开终端手动启动前端。

VS Code 中使用：

- `Frank: Tauri Dev (auto UAC)`：启动 Vite、Tauri 和 Rust 后端，普通 VS Code 可用；包装脚本会自动请求 UAC，并支持前端热更新；
- `Frank: Rust Backend (MSVC, Administrator)`：使用 MSVC 调试器启动 Rust 后端，前端使用预先构建的 `dist`，适合定位 Rust 代码；由于目标程序自身要求提权，建议以管理员身份运行 VS Code。

### 只启动前端

```powershell
pnpm dev
```

这只能验证 Vue/Vite 页面。页面中的 Tauri `invoke()`、窗口创建和 Rust 功能不会正常工作，因为没有 `Frank.exe` 宿主。

### 正式构建

```powershell
pnpm run tauri build
```

该命令会先执行 `pnpm build`，再编译并打包 Tauri 应用。

## 7. 权限模式

`src-tauri/build.rs` 为 Debug/Release 构建都声明了 `requireAdministrator`。原因是 Rust 后端需要读取 `LeagueClientUx.exe` 的命令行，以获得 LCU 端口和认证 Token；Windows 可能拒绝普通权限进程访问这些信息。

VS Code 本身不必管理员运行。`.vscode/tauri-msvc.cmd` 检测到当前终端未提升时，会通过 `.vscode/elevate-tauri.ps1` 请求一次 UAC，并在提升后的进程中启动 Tauri。这样前端 Vite 和 Rust/Tauri 后端仍由同一个 `tauri dev` 流程启动，但日志可能显示在 UAC 启动的新控制台窗口中。

如果某个功能需要写入受保护目录，仍可能遇到额外的文件权限限制。

## 8. 维护约定

发生以下改动时，应同步更新本文：

1. 新增或删除 Tauri 窗口标签；
2. 新增、删除或重命名 Rust command；
3. 修改 `beforeDevCommand`、`devUrl` 或 `frontendDist`；
4. 修改 Debug/Release 权限策略；
5. 改变前端与 LCU 的通信方式；
6. 改变 VS Code 的启动任务或调试配置。
