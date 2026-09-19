# 本地试验台 · Local Test Lab

这是一个面向个人本机验证的 League Client 辅助工具，重点用于本地测试 LCU 连接、游戏流程监听、战绩读取、符文配置和窗口联动。

项目仅供内部测试使用，不提供公开下载入口、在线公告或对外宣传页面。应用通过本机正在运行的 League Client LCU 获取数据；部分英雄资源仍会按功能需要访问对应的数据接口。

## 技术栈

- Rust
- Tauri 2
- Vue 3
- TypeScript
- Tailwind CSS

## 目录结构

```text
src
├─assets                # 图标、字体和本地资源
├─background            # 后台逻辑窗口
├─lcu                   # LCU 接口
├─main                  # 主窗口
│  ├─router
│  ├─store
│  └─views
│      ├─home           # 本地测试入口
│      ├─rank           # 英雄数据排行
│      ├─record         # 排位笔记
│      ├─rune           # 符文配置
│      └─teammate       # 队友数据
├─matchAnalysis         # 战绩分析窗口
├─queryMatch            # 查询战绩窗口
├─recentMatch           # 最近对局窗口
└─resources             # 静态数据

src-tauri
├─icons                 # 桌面打包图标
└─src                   # Tauri/Rust 宿主
```

## 本地运行

Windows 桌面构建需要 Node.js、pnpm、Rust MSVC toolchain、Microsoft C++ Build Tools（含 Windows SDK）和 WebView2。完整安装包还需要 WiX 3 和 NSIS。

```powershell
pnpm install
pnpm run tauri dev
```

由于需要读取 League 客户端进程参数来取得 LCU 端口和 Token，Debug/Release 构建都使用 `requireAdministrator`。VS Code 启动配置会在需要时请求 UAC。

## 构建

```powershell
pnpm run build
pnpm run tauri build
```

本地测试版本默认使用“本地试验台”品牌和图标，不包含公开下载、手册、赞助或更新推送入口。
