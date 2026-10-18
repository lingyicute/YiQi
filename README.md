<h1>YiQi</h1>
<h3></h3>

<p>纯前端围棋对弈小游戏：KataGo 人类模型驱动的四档人机对战（20级 → 3段），双人同屏，9 / 13 / 19 路棋盘，中国规则（数子法，黑贴 7.5 目）。</p>
<p>Made with ❤️ by <a href="https://github.com/lingyicute">lingyicute</a>.</p>
<br>
<p>
  <a href="https://github.com/lingyicute/YiQi">🌐 Source Code</a> •
  <a href="https://github.com/lingyicute/YiQi/issues">🐛 Report Bug</a>
</p>
<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-orange.svg" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/%E8%A7%84%E5%88%99-%E4%B8%AD%E5%9B%BD%E5%A4%A7%E9%99%86%E8%A7%84%E5%88%99-red" alt="中国大陆规则">
  <img src="https://img.shields.io/badge/AI-KataGo%20%E4%BA%BA%E7%B1%BB%E7%BD%91%E7%BB%9C-blue" alt="AI: KataGo 人类模型">
  <img src="https://img.shields.io/badge/%E5%90%8E%E7%AB%AF-%E6%97%A0-brightgreen" alt="无后端">
</p>
<br>

## ✨ 特性

- **⚖️ 严谨全面的规则系统**
  - 数子法计分，黑贴 7.5 目（3¾ 子）；
  - 禁全局同形（位置超级劫）：打劫须先寻劫，回提受限；
  - 禁自杀；双方连续停一手即终局，自动进入计分；
  - 计分阶段可点击棋子标记 / 恢复死子，地域实时着色（人机对局中 AI 按形势判断先标一版）；
  - 棋谱可导出为 SGF。

- **🤖 强力的四档人机对战**
  - **简单 = 20级 / 中等 = 8级 / 困难 = 1段 / 专家 = 3段**：KataGo **人类模型**（b18c384nbt-humanv0）按段位档位模仿真实人类棋手的布局与棋风；
  - 判断「停一手 / 胜负」由小型主模型（g170-b6c96，3.65 MiB）以 64 visits 完成；
  - AI 棋力与棋风全部来自人类模型——不靠「放水」降低棋力。

- **👥 双人同屏功能**：两人轮流落子，不计入战绩。

- **🎛️ 9 / 13 / 19 路棋盘可选**：星位随路数自适应；切换棋盘即开新局。

- **↩️ 悔棋、PASS、计时**：人机模式悔棋同时撤回 AI 一手；`Z` 悔棋、`P` 停一手、`R` 重开。

- **💾 续局**：未完成的对局保存在浏览器，重开页面自动恢复（含用时）。

- **📊 战绩统计**：按难度记录人机胜负（合并执黑与执白）。

- **🎨 Material You**：深色 / 浅色主题一键切换，八种强调色（紫/蓝/青/绿/黄/橙/粉/红），跟随系统主题防闪烁。

- **📱 全设备自适应**：宽屏两栏（棋盘右侧铺满），窄屏单列；鼠标悬停预览、触屏「抬起落子」（滑动不误触）、键盘光标（方向键 / WASD）。

- **🔊 音效与触感**：Web Audio 落子音（黑白不同音高）、胜利琶音、移动端振动。

<br>

## 🚀 Try it

直接访问 **https://yiqi.92li.uk** （Cloudflare Pages 自动部署本仓库）。

- 首次使用人机对战需下载 KataGo 模型（约 103 MB，含 94.5 MB 人类模型），下载后存入浏览器 Cache Storage 长期复用；可选择跳过，只用双人对战。
- 人机对战需要 **WebAssembly**。
- 支持 WebGPU 的浏览器（Chrome/Edge 121+，iOS/iPadOS 26+）会自动启用 WebGPU 后端，否则回退 WASM（多线程需跨域隔离，站点已配置 COOP/COEP）。

<br>

## 🎮 操作

| 操作 | 方式 |
| --- | --- |
| 落子 | 点击 / 轻触交叉点；或方向键、WASD 移动光标后按 `空格` / `回车` |
| 停一手 | `P` 或 ⏸ 按钮（双方连续停一手进入计分） |
| 悔棋 | `Z` 或 ↩ 按钮 |
| 重新开始 | `R` 或 ↻ 按钮 |
| 计分阶段标记死子 | 点击棋子（整组切换） |
| 关闭对话框 / 菜单 | `Esc` 或点击遮罩 |

<br>

## 📁 目录

```
├── index.html              # 页面骨架
├── public/
│   ├── _headers            # Cloudflare Pages 配置：COOP/COEP + 模型缓存/类型
│   ├── ai/                 # KataGo 模型（主模型 + 人类模型 4 分片）
│   └── tfjs/               # TF.js WASM 运行时（build 时拷入，不入库）
├── src/
│   ├── core/rules.ts       # goban-engine 封装（着法序列接口）
│   ├── ai/                 # web-katrain 引擎移植 + 客户端 + 模型下载
│   │   └── katago/         # 引擎层（MCTS / 特征 / 模型解析 / Worker）
│   ├── ui/                 # 画布渲染 / 对局控制 / 设置 / 音效
│   ├── main.ts             # 装配与事件
│   └── style.css           # Material You 主题（8 色 × 明暗）
├── tests/                  # 规则单测 / 引擎单测 / UI E2E / AI 全链路 E2E
└── scripts/copy-tfjs-wasm.mjs
```

<br>

## 🤖 CI（GitHub Actions）

`.github/workflows/build.yml`：每次提交到 `main` 立即构建（`npm ci` → 拷贝 TF.js WASM → `vite build`），
构建前执行 TypeScript 检查与单元测试，通过后才把 `dist/` 产物提交回库。

`.github/workflows/check.yml`：对 Pull Request 执行类型检查、单元测试、生产构建及 Chromium UI / 模型缓存 / AI 全链路测试；该工作流仅有仓库读取权限，不提交构建产物。

<br>

## 🎨 本地开发（Node.js 20.19+，建议使用受支持的 LTS 版本）：

```bash
git clone https://github.com/lingyicute/YiQi.git
cd YiQi
npm ci
npm run copy:tfjs-wasm   # 拷贝 TF.js WASM 运行时到 public/tfjs/
npm run dev              # http://localhost:5173
```

开发/预览服务监听 `0.0.0.0`，请仅在可信网络运行。默认保留 Vite 的 Host 校验；反向代理或远程预览需要额外域名时，显式设置，例如 `YIQI_ALLOWED_HOSTS=preview.example.com npm run dev`（逗号分隔，不填写不受信任的域名）。

生产构建与预览：

```bash
npm run build            # 自动拷贝 WASM，产物在 dist/
npm run preview          # 本地预览 dist/（带 COOP/COEP 头）
```

字体：Nebulove 子集位于 `src/fonts/nebulove-subset.woff2`，由 `src/style.css` 的 `@font-face` 引用，构建后使用带哈希的静态资源 URL。**修改界面文案后**请 `pip install fonttools brotli` 并重跑 `npm run subset:font`，否则新增字符会回退到系统字体。

<br>

## 🧪 测试

```bash
npm run test:rules        # 规则层单测（提子/打劫/超级劫/计分/悔棋/SGF）
npm run test:engine       # KataGo 引擎层（模型解析/MCTS/人类网络元数据，需模型文件）
npm run test              # 全部单元测试（含缓存、Worker、存档、解析器与规则差分）
node tests/e2e.mjs        # UI 端到端（需先 build + preview）
node tests/e2e-ai.mjs     # AI 全链路端到端（下载→初始化→人机对弈→缓存）

# 推荐的一次性完整浏览器验证：自动启动/关闭生产预览服务
npx playwright-core install --with-deps chromium
npm run build
npm run test:e2e
# 已有预览服务时：BASE_URL=http://localhost:4173 npm run test:e2e
```

<br>

## 📄 许可

- 本项目代码：**AGPL-3.0**，见 [LICENSE](./LICENSE)。
- 依赖：
  - 规则层 [goban-engine](https://github.com/online-go/goban)：Apache-2.0（Online-Go.com）
  - AI 层移植自 [web-katrain](https://github.com/Sir-Teo/web-katrain)：MIT，保留声明见 [web-katrain-MIT.txt](public/licenses/web-katrain-MIT.txt)
  - [KataGo](https://github.com/lightvector/KataGo) 引擎主体代码：MIT（外部组件另有许可，见 [KataGo LICENSE](public/licenses/KataGo-LICENSE.txt)）。
  - TensorFlow.js：Apache-2.0

由 ❤️ 与 KataGo 驱动 · [lingyicute](https://github.com/lingyicute)
