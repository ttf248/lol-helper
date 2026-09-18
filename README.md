<h2 align="center">
Frank Powered By Java_S
</h2>
<p align="center">
<a href="https://lolfrank.cn" rel="nofollow"><img src="./public/preface.jpg"></a>
</p>
<p align="center">
<a href="https://lolfrank.cn" style="margin-right: 24px" rel="nofollow">🚀立即下载</a>
<a href="https://www.yuque.com/java-s/frank/introduction" rel="nofollow">🔎使用手册</a>
</p>

## 👋 介绍

Frank是一款简洁的，轻量的，免费的，开源的英雄联盟助手。 本软件的使命是当好游戏玩家的幕后小助手，提供一些便捷游戏的服务，让你的游戏体验更上一层楼。 当然，Frank是正经助手，不搞幺蛾子！任何违反 Riot 和腾讯规定的行为，我们都不鼓励，更不支持。 毕竟，公平游戏才是真高手的战场！战绩窗口通过本机正在运行的 League Client LCU 查询当前账号所在大区的对局数据，并支持本地搜索召唤师；该功能依赖客户端接口，仅面向个人本地使用。

## 🔧 技术栈

- Rust
- Tauri
- Vue3
- Typescript
- TailwindCSS

## 📊 目录结构

```
src
├─assets                # 一些资源文件
├─background            # 前端的逻辑窗口
├─lcu                   # Lcu接口
├─main                  # 主窗口
│  ├─router
│  ├─store
│  └─views
│      ├─home           # 首页
│      ├─rank           # 英雄数据排行
│      ├─record         # 排位笔记
│      ├─rune           # 符文配置
│      └─teammate       # 队友数据
├─matchAnalysis         # 战绩数据分析窗口
├─queryMatch            # 我的战绩窗口
├─recentMatch           # 对局详情战绩窗口
├─resources             # 一些资源

src-tauri
├─icons
├─src
│  ├─lcu
│  └─shaco              # 连接lcu第三方库
│  └─lib.rs             # 入口函数
│  └─main.rs
│  └─lcu.rs
```

## 🛠 开发环境

Windows 桌面构建需要 Node.js、pnpm、Rust MSVC toolchain、Microsoft C++ Build Tools（含 Windows SDK）和 WebView2。当前仓库已固定使用 `pnpm@9.15.9`；完整安装包还需要 WiX 3 和 NSIS。

Frank 需要读取 League 客户端进程参数来取得 LCU 端口和 Token，因此 Debug/Release 构建均使用 `requireAdministrator`。VS Code 本身不必管理员运行；`.vscode/tauri-msvc.cmd` 会在普通终端中自动请求 UAC，并在提升后的进程中启动 Tauri。项目已提供 `.vscode/launch.json`、`.vscode/tasks.json` 和 MSVC 环境包装脚本。

## 📥 运行

```
git clone https://github.com/SYJun404/frank.git
cd frank
pnpm install
pnpm run tauri dev
```

构建

```
pnpm run tauri build
```

## 点个 Star 支持我们 ⭐

<p align='center'>
  <a href="https://github.com/SYJun404/frank/stargazers">
    <img src="https://star-history.dera.page/svg?repos=SYJun404/frank&type=Date">
  </a>
</p>
