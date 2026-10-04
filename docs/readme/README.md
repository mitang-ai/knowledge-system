# README 素材

README 只使用三张正文图片，放在 `assets/`。不加载私人相册、线上账号、导入包或生产数据库。

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| workspace.png | 真实应用界面，独立临时数据库中的合成内容 | 让读者看到产品现在的样子 |
| knowledge-flow.png | 内置 image_gen，按「极简线条信息图」Skill 生成 | 解释记录、主题、理解和回顾的关系 |
| ai-boundary.png | 同一 Skill 与工具生成 | 解释浏览器直连 AI 与人工确认收录的边界 |

两张信息图均为黑白线条，中文标签经过逐项查看。原始尺寸 1672 × 941，接近 16:9，不声称是精确 16:9。直接保存模型原图，没有二次修图或额外绘制。截图为 1440 × 960，合成笔记不进入产品默认数据。

## 复现界面截图

先构建应用，再使用 Node Playwright 和已安装的 Chromium：

```sh
npm ci
npm run build
node scripts/readme-screenshot.mjs
```

Node Playwright 不属于应用的运行依赖，需要在截图环境单独提供。脚本优先读取已安装的 `playwright`，也支持 `CODEX_NODE_MODULES` 指定模块目录；在 Codex 桌面环境可使用 bundled runtime。可用 `PYTHON` 指定 Python，`SEDIMENT_CHROMIUM` 指定 Chromium 可执行文件。

脚本启动随机 loopback 端口，并将 `SEDIMENT_STORAGE` 固定为新的临时目录。只通过本地接口创建示例内容，不读取已有数据。截图后关闭浏览器、终止所创建的进程树、检查路径后清理临时目录。更换 UI 时重新运行并查看成品，不用图片生成模型伪造界面。

## 信息图生成提示词

两张图的提示词包含文字白名单、箭头方向、允许出现的节点及禁用的装饰。修改事实关系时一并修改图片和文字。

<details>
<summary>记录与理解</summary>

```text
Use case: infographic-diagram. Asset: open-source GitHub README explanatory illustration for 沉淀, a monochrome personal knowledge workspace. Draw one horizontal 16:9 minimalist line-art infographic on pure white, with generous whitespace and thick clean black hand-drawn outlines. All colors strictly black and white to match this product. Four evenly spaced groups read left-to-right across the middle: (1) a very simple round-headed stick person writing a short note on paper, (2) a small cluster of note cards connected to one theme folder, (3) a page receiving one new paragraph next to its original text, (4) the same simple person revisiting an open notebook, with a small clock. A single short clear rightward arrow connects each adjacent group. These arrows represent a possible usage journey, not background automation. Keep drawing objects large and composed, not crowded. Use only these four exact Simplified Chinese labels in a clean, clearly legible font beneath the corresponding groups: “记下来”, “归到主题”, “补充理解”, “回头看看”. Text whitelist is exactly those four labels, each once. No other text, no title or subtitle, no Latin filler, no corner numbers, no logos, no watermarks, no decorative symbols, no gradients, no paper texture, no hatching, no shadows, no 3D. This must feel like a quiet, precise hand-drawn explanation, not a sticker collage or UI mockup. Leave at least 8 percent margins on every edge. Target wide 16:9 composition.
```

</details>

<details>
<summary>AI 数据边界</summary>

```text
Use case: infographic-diagram. Asset: second GitHub README illustration explaining the actual AI data boundary of 沉淀. Draw one horizontal 16:9 minimalist line-art infographic, pure white background, black-only crisp hand-drawn thick outlines, lots of breathing room, no texture or decoration. Three functional groups: a large thin outlined browser window occupies the left half, a small outlined cloud representing the user's own AI service is upper-right, an outlined knowledge notebook representing the application's saved knowledge is lower-right. Inside the browser draw a key and two selected document pages, with clear labels “API Key” and “选中的材料”; label the browser itself “浏览器”. The upper-right cloud is labeled “你的 AI 服务”. A rightward arrow travels from the browser's key and selected pages to that AI service. A separate return arrow travels from AI service back to browser, labeled “回答”. At browser lower-right, a tiny simple round-headed person intentionally clicking a checkmark precedes a separate rightward arrow toward the lower-right knowledge notebook; label that arrow “确认收录”, label the notebook “知识系统”. This lower route represents only material the user chooses to save, never API keys. Do not draw any connection between the key and knowledge system, or between AI cloud and knowledge system: AI calls are direct from browser, and confirmed knowledge saving is a separate user action. Text whitelist, each rendered at most once: “浏览器”, “API Key”, “选中的材料”, “你的 AI 服务”, “回答”, “确认收录”, “知识系统”. Large readable Simplified Chinese labels, exactly these strings, no extra prose or invented claims. No padlock suggesting encrypted browser storage, no logo, footer, slogan, caption, watermarks, gradients, fills, shadows, colorful arrows or decorative stars. Keep arrows separated, their start/end points unambiguous, never crossing. Target wide 16:9 composition with at least 8 percent margins.
```

</details>

## README 的展示约定

徽章只展示源码版本、MIT、真实 GitHub Actions 状态和 Star 数量。不使用固定的 passing、下载量、覆盖率或商店上架标记冒充实际状态。操作按钮都有真实入口，迁移与开发细节使用 GitHub 的折叠内容。

渲染检查参考 [GitHub Markdown API](https://docs.github.com/en/rest/markdown/markdown)；动态徽章格式参考 [Shields 工作流状态文档](https://shields.io/badges/git-hub-actions-workflow-status)。本地预览只用于排版检查，不替代推送后的仓库读回。
