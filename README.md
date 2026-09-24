# LOL Helper（本地试验台）

面向 Windows 的 League Client 桌面辅助工具，提供召唤师与对局查询、历史战绩分析，以及游戏内最近对局信息。桌面应用由 Tauri 2、Vue 3、TypeScript 和 Rust 构建；应用显示名称为 **Local Test Lab（本地试验台）**。

[下载最新版本](https://github.com/ttf248/lol-helper/releases/latest) · [查看项目源码](https://github.com/ttf248/lol-helper)

项目目前以本机功能验证为主。英雄联盟客户端的本地接口（LCU）和区域战绩接口（SGP）可能变化，部分功能会受其影响。

## 功能

- 连接本机 League Client，查询当前账号及同大区召唤师的资料、段位和对局。
- 查看对局列表、双方玩家与单局数据，并按最近 20、50、100 或最多 500 场回顾胜率趋势、常用英雄和位置表现。
- 在最近对局窗口查看玩家信息、英雄与位置统计、同队关系图，并根据历史对局推断常见队友组合。组队关系是启发式分析，不是游戏客户端提供的官方组队信息。
- 监听 League Client 和游戏流程，并可设置窗口贴边跟随。

## 下载和运行

1. 从 [GitHub Releases](https://github.com/ttf248/lol-helper/releases/latest) 下载 Windows 安装包：`.msi` 或 NSIS 安装程序 `.exe`。
2. 安装后启动应用。程序需要管理员权限读取 League Client 的启动参数，Windows 会显示 UAC 提示。
3. 启动并登录 League Client 后使用召唤师搜索和对局查询。

本项目当前只构建 **Windows x64** 版本。查询需要网络连接，以访问 Riot 区域战绩服务和英雄静态资源；项目不使用 Riot Developer Portal 的 API Key。

### 本地战绩缓存

历史缓存和跨场次分析使用本机 PostgreSQL。当前版本默认连接 `127.0.0.1:5432`，数据库名 `lol`，用户名 `lol`，密码 `helper`。请先安装并启动 PostgreSQL，并创建对应用户和数据库；应用连接后会自动创建和迁移所需表结构。

可在 PostgreSQL 的 `postgres` 数据库中执行以下命令创建首次使用的账号和数据库：

```sql
CREATE ROLE lol LOGIN PASSWORD 'helper';
CREATE DATABASE lol OWNER lol;
```

如果该本地数据库不可用，缓存和依赖缓存的历史分析无法正常使用；召唤师和战绩接口本身仍需要已登录的 League Client。

## 从源码运行

### 环境要求

- Windows 10/11 x64
- Node.js 22 和 pnpm 9（仓库使用 `pnpm@9.15.9`）
- Rust stable，MSVC 工具链
- Visual Studio C++ Build Tools 和 Windows SDK
- WebView2 Runtime
- 若要生成 Windows 安装包：WiX Toolset 3 和 NSIS

### 开发模式

```powershell
git clone https://github.com/ttf248/lol-helper.git
cd lol-helper
pnpm install --frozen-lockfile
pnpm run tauri dev
```

Tauri 开发模式也会请求管理员权限。单独运行 `pnpm dev` 只能预览前端页面，不能使用 LCU、Rust 后端或桌面窗口功能。

### 构建安装包

```powershell
pnpm run tauri build
```

Windows 安装包输出在 `src-tauri/target/release/bundle/` 下的 `msi` 和 `nsis` 目录。该命令会先构建前端，再编译 Rust 宿主并打包桌面应用。

## 自动发布 GitHub Release

工作流位于 [`.github/workflows/release.yml`](.github/workflows/release.yml)。向 GitHub 推送与应用版本一致的 `v*` 标签后，GitHub Actions 会构建 Windows x64 安装包并创建已发布的 Release。工作流使用 GitHub 自动生成的 `GITHUB_TOKEN`，无需另行保存个人访问令牌。

发布前确保 `package.json` 与 `src-tauri/tauri.conf.json` 中的版本号一致，然后在该版本提交上创建并推送标签。例如当前版本为 `3.27.1615`：

```powershell
git tag v3.27.1615
git push https://github.com/ttf248/lol-helper.git v3.27.1615
```

Release 页面：<https://github.com/ttf248/lol-helper/releases>

## 项目结构

```text
src/
├─ background/    客户端监听、游戏流程和窗口协调
├─ lcu/           LCU、SGP 数据请求
├─ main/          主界面
├─ queryMatch/    召唤师查询、对局详情和历史分析
└─ recentMatch/   最近对局与同队关系分析
src-tauri/
└─ src/           Tauri/Rust 宿主、LCU 通信和 PostgreSQL 缓存
docs/              架构、数据流、协议和分析说明
```

更多维护文档见 [`docs/`](docs/)。

## 数据来源

应用从本机 League Client 读取 LCU 连接信息，通过本机接口获取召唤师资料、对局和游戏流程；战绩查询也会访问 Riot 区域 SGP 服务。历史数据保存在本机 PostgreSQL。英雄图像等静态资源，以及辅助分析使用的举报/黑名单标记，可能来自外部服务。详细说明见[协议与接口文档](docs/protocols.md)。

## 技术栈

- 桌面端：Tauri 2、Rust
- 界面：Vue 3、TypeScript、Vite、Naive UI、Tailwind CSS
- 本地历史缓存：PostgreSQL

## 许可

本项目使用 [MIT License](LICENSE)。
