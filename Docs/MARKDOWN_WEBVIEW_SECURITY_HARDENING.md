# 花笺 Markdown 与 WebView 安全加固说明

**审查日期**：2026-08-02<br>
**基线版本**：`v1.2.2`，提交 `636f052`<br>
**范围**：Markdown 预览、外部 Markdown 文件、asset protocol、CSS 注入、Tauri WebView CSP。
**目标**：保留本地优先笔记体验，同时收紧不可信 Markdown、外部图片和动态文件授权的边界。

## 实施状态（2026-08-02）

- **已实施并通过构建/测试**：W1 CSP、W2 原始 HTML 的任意内联样式、W3 外部文件 HTML 隔离、W4 远程图片默认阻断、W5 外部图片受控缓存。
- **已否决的错误方案**：Tauri 的 asset scope 只支持追加 allow/forbid，`forbid_directory` 的拒绝规则永久优先，不能作为“关闭时释放，之后重新打开又授权”的 API。原先的引用计数伪代码会使同目录无法再次加载，已明确废弃。
- **保留的特权功能**：W6 自定义 CSS；已由 W1 的 CSP 阻止它加载远程样式、图片与字体。

> 本文是整改设计和实施清单，不代表当前版本已存在任意代码执行漏洞。
>
> 现有实现已经做了多项正确防护：原始 HTML 默认关闭；开启后经过 `rehype-sanitize`；外部文本路径限制为绝对路径、受限扩展名、常规文件和 25 MB 上限；外部相对图片禁止 `..` 越出其父目录；内部 SVG 拒绝包含 `<script` 的内容；Tauri capability 未给前端暴露通用文件系统插件。本文修复的是这些防线失效后的缺口、隐私泄露面和权限生命周期问题。

---

## 1. 结论与优先级

| ID | 结论 | 风险等级 | 影响条件 | 建议版本 |
| --- | --- | --- | --- | --- |
| W1 | 生产 WebView 的 CSP 为 `null` | 高 | Markdown 处理或未来依赖出现 XSS/资源加载绕过时 | **已实施** |
| W2 | 原始 HTML 白名单允许任意 `style` 属性 | 中 | 用户开启“允许 HTML 标签渲染”并预览不可信内容 | **已实施** |
| W3 | 外部 Markdown 与内部笔记共用 HTML 渲染开关 | 中 | 用户曾开启 HTML，随后打开第三方 `.md` / `.html` | **已实施** |
| W4 | Markdown 的远程图片默认请求网络 | 中，隐私 | 笔记含 `http(s)` 图片，无需开启 HTML | **已实施** |
| W5 | 外部文件父目录会被递归加入全局 asset scope，且不会撤销 | 中 | 本次运行中打开过多个外部目录，或有 XSS/样式绕过 | **已实施缓存替换** |
| W6 | 自定义 CSS 可直接注入应用 `<style>` | 低，设计风险 | 配置文件被篡改、用户粘贴不可信 CSS，或 W1/W2 被绕过 | CSP 已缓解网络面 |

### 修复顺序

1. W1、W2、W3、W4、W5 已合并：减少远程加载和不可信内容的攻击面。
2. W5 已改用逐图缓存；`forbid_directory` 引用计数方案因 Tauri scope 的不可撤销语义被明确弃用，详见第 7 节。
3. W6 不建议删除“自定义 CSS”功能。将其明确定义为本机高级设置，并依靠 CSP 禁止它联网加载资源。

---

## 2. 当前信任边界

### 2.1 数据如何进入 WebView

1. 内部笔记正文由本地笔记库读取。
2. 外部 `.md`、`.markdown`、`.txt`、`.html`、`.htm` 由 `read_external_file` 读取。
3. `MarkdownPreview` 在预览模式将内容交给 `react-markdown`。
4. 当设置 `renderHtmlMarkdown` 为 `true` 时，额外启用 `rehype-raw` 解析原始 HTML。
5. 外部 Markdown 的相对图片先解析到 canonical 路径，再由 `cache_external_markdown_image` 复制到应用自己的 `external-previews` 缓存；WebView 仅通过 `convertFileSrc` 加载缓存副本。

### 2.2 现有正确控制

| 控制 | 位置 | 作用 |
| --- | --- | --- |
| HTML 默认关闭 | `src-tauri/src/services/notes.rs` 的 `render_html_markdown` 默认值；`src/components/MainWindow.tsx` | 默认 Markdown 不解析嵌入 HTML |
| HTML 消毒 | `src/features/markdown/MarkdownPreview.tsx` | `rehypeRaw` 后紧接 `rehypeSanitize`，移除脚本、事件属性、iframe 等默认不允许节点 |
| 外部文本路径校验 | `src-tauri/src/lib.rs` 的 `validate_external_text_path` | 限制绝对路径、文本扩展名、普通文件、大小 |
| 外部图片逃逸防护 | `src/features/markdown/imageSrc.ts` | 相对图片路径按段处理，`..` 不能离开外部文件父目录 |
| 动态目录使用 canonical 路径 | `src-tauri/src/lib.rs` 的 `external_file_image_base_dir` | 避免符号链接别名绕过目录判断 |
| 默认 capability 收紧 | `src-tauri/capabilities/default.json` | 未启用通用文件系统读写能力 |

这些控制应继续保留，整改时不要用“大重构”把它们弄丢。杂鱼式重写最容易把原来修好的边界又拆掉。

---

## 3. W1：CSP 关闭

### 3.1 定位

文件：`src-tauri/tauri.conf.json`

当前配置：

```json
"security": {
  "csp": null,
  "assetProtocol": {
    "enable": true,
    "scope": []
  }
}
```

### 3.2 为什么这是问题

CSP 是 WebView 的资源加载和脚本执行兜底。当前应用会渲染用户 Markdown，支持可选原始 HTML、远程图片和自定义 CSS；即使现有 sanitizer 正常工作，仍应假设未来依赖升级、组件改动或某个解析绕过可能让恶意节点进入 DOM。

`csp: null` 表示没有浏览器层限制。后果包括：

- 一旦有 XSS，脚本可加载任意第三方脚本或向任意地址发请求。
- 任意 `<img>`、CSS `url(...)`、`@import` 可直接联网，扩大隐私泄露面。
- CSP 无法限制被注入 CSS 伪造 UI、覆盖点击区域或加载外部字体/样式。

这不是“当前 sanitizer 已经被绕过”的证据。风险来自应用把全部防护押在单层解析规则上。

### 3.3 修复方案

先采用严格的离线优先策略：不允许 WebView 从 `https:` 加载图片、样式、字体、脚本或发起网络连接。应用更新下载由 Rust `reqwest` 完成，不依赖 WebView `connect-src`。

在 `src-tauri/tauri.conf.json` 将 `csp: null` 替换为对象：

```json
"security": {
  "csp": {
    "default-src": "'self' asset:",
    "base-uri": "'none'",
    "object-src": "'none'",
    "script-src": "'self'",
    "style-src": "'self' 'unsafe-inline'",
    "img-src": "'self' asset: data: blob:",
    "font-src": "'self' data:",
    "connect-src": "'self' ipc: http://ipc.localhost",
    "media-src": "'self' asset: data: blob:",
    "frame-src": "'none'",
    "form-action": "'none'"
  },
  "assetProtocol": {
    "enable": true,
    "scope": []
  }
}
```

### 3.4 配置取舍

- `style-src 'unsafe-inline'` 暂时保留，因为项目使用 React inline style，并支持可信本机用户的自定义 CSS。它不等于允许内联脚本。
- `img-src` 仅允许应用自身、asset protocol、`data:` 和 `blob:`。这会阻止远程 Markdown 图片，正好落实 W4。
- `connect-src` 保留 Tauri IPC 所需地址。实际 Tauri 生产协议因平台和配置可能不同，构建后必须打开主窗口检查 DevTools Console 的 CSP 报错；只新增报错中确有业务必要的源，不能为了“少报错”加 `https:` 或 `*`。
- 不加入 `'unsafe-eval'`、`https:`、`*` 或任意第三方脚本源。

### 3.5 验收

```powershell
npm run build
npm run tauri dev
```

在实际窗口验证：

1. 内置字体、KaTeX、笔记图片、背景图、打印预览正常。
2. Markdown 中 `![test](https://example.com/x.png)` 不产生网络请求且显示失败占位或空白。
3. 控制台无合法资源被 CSP 拦截的报错。
4. 下述 W2、W3 测试 payload 不产生脚本执行或请求。

官方依据：Tauri v2 CSP 文档要求开发者显式配置 CSP，并建议只允许可信资源源；asset protocol 也需要在 CSP 中加入 `asset:`。

---

## 4. W2：Markdown 消毒策略允许任意行内 style

### 4.1 定位

文件：`src/features/markdown/MarkdownPreview.tsx`

当前 schema 为：

```ts
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "center", "font", "u", "abbr"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "style",
      "className",
      "data-alert-type",
      "dataAlertType",
    ],
    font: ["color", "size", "face"],
    abbr: ["title"],
  },
};
```

### 4.2 为什么这是问题

`rehype-sanitize` 的默认 schema 采用保守白名单。当前扩展把 `style` 加到 `*`，等于所有允许 HTML 元素都可以附加任意 CSS。

即使没有 JavaScript，攻击者仍可能：

- 用 `position: fixed; inset: 0` 覆盖应用界面，伪造保存、更新、授权等 UI。
- 用 `visibility`、`opacity`、`z-index` 隐藏真实按钮或引导点击。
- 在 CSP 缺失时通过 `background-image: url(https://...)` 发起网络请求。
- 使用 CSS 选择器和布局制造误导性内容。

原始 HTML 只在用户主动开启设置后启用，因此这里更适合归类为中风险的防御纵深问题。

### 4.3 修复方案

去掉任意 `style`；仅保留实现已声明的语义化 HTML。KaTeX 插件在 sanitizer **之后**运行，因此去掉用户 HTML 的 `style` 不会删除 `rehype-katex` 生成的可信输出。

将 schema 替换为：

```ts
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "center", "font", "u", "abbr"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "className",
      "data-alert-type",
      "dataAlertType",
    ],
    font: ["color", "size", "face"],
    abbr: ["title"],
  },
};
```

如果产品必须支持少数展示样式，不要恢复通用 `style`。改用受控语义：

```html
<mark>重点</mark>
<font color="#b45309">强调</font>
```

或只允许白名单 class，再由应用 CSS 维护其定义：

```ts
span: [
  ...(defaultSchema.attributes?.span ?? []),
  ["className", "note-callout", "note-muted"],
],
```

不要把 `/^.+$/` 这样的正则放进 `className` 白名单，那会重新给任意 class 打开入口。

### 4.4 新增前端测试

在 `src/features/markdown/MarkdownPreview.test.tsx` 增加：

```tsx
test("removes inline styles from raw HTML", () => {
  const markup = renderToStaticMarkup(
    <MarkdownPreview
      renderHtml
      content={'<p style="position:fixed;inset:0">untrusted</p>'}
    />,
  );

  expect(markup).toContain("untrusted");
  expect(markup).not.toContain("position:fixed");
  expect(markup).not.toContain('style=');
});

test("removes script and event attributes from raw HTML", () => {
  const markup = renderToStaticMarkup(
    <MarkdownPreview
      renderHtml
      content={'<img src="x" onerror="alert(1)"><script>alert(1)</script>'}
    />,
  );

  expect(markup).not.toContain("onerror");
  expect(markup).not.toContain("<script");
});
```

注意：服务端静态渲染不能证明浏览器里没有事件执行。它用于回归验证 HTML AST 是否被消毒；最终仍要在真实 WebView 中打开 payload。

---

## 5. W3：外部文件不应继承全局“允许 HTML”开关

### 5.1 定位

文件：`src/components/MainWindow.tsx`

当前预览调用：

```tsx
<MarkdownPreview
  content={deferredContent}
  fontSize={settingsConfig?.fontSize ?? 14}
  renderHtml={settingsConfig?.renderHtmlMarkdown ?? false}
  imageBaseDir={isExternal ? undefined : (imageBaseDir ?? undefined)}
  externalImageBaseDir={
    isExternal ? (externalImageBaseDir ?? undefined) : undefined
  }
  onOpenWikiLink={handleOpenWikiLink}
/>
```

`isExternal` 已经存在，却没有参与 `renderHtml` 决策。这意味着用户在阅读自己笔记时开启一次 HTML，之后打开下载目录里的第三方 Markdown 或 `.html`，外部内容会自动获得 HTML 渲染能力。

### 5.2 修复方案

安全默认值：**外部文件永远按安全 Markdown 渲染**。内部笔记可继续使用现有开关。

```tsx
const allowRawHtml = !isExternal && (settingsConfig?.renderHtmlMarkdown ?? false);

<MarkdownPreview
  content={deferredContent}
  fontSize={settingsConfig?.fontSize ?? 14}
  renderHtml={allowRawHtml}
  imageBaseDir={isExternal ? undefined : (imageBaseDir ?? undefined)}
  externalImageBaseDir={
    isExternal ? (externalImageBaseDir ?? undefined) : undefined
  }
  onOpenWikiLink={handleOpenWikiLink}
/>
```

不要提供“对所有外部文件永久记住”选项。若将来确实有用户需求，应采用一次性确认，并明确显示完整文件路径、风险说明和本次有效范围；不要把此决定写入全局设置。

### 5.3 验收测试

建议把该逻辑抽为纯函数，避免只能靠大组件集成测试：

```ts
// src/features/markdown/renderPolicy.ts
export function canRenderRawHtml(
  isExternal: boolean,
  configured: boolean,
): boolean {
  return !isExternal && configured;
}
```

```ts
// src/features/markdown/renderPolicy.test.ts
import { describe, expect, test } from "vitest";
import { canRenderRawHtml } from "./renderPolicy";

describe("canRenderRawHtml", () => {
  test("allows explicit HTML only for managed notes", () => {
    expect(canRenderRawHtml(false, true)).toBe(true);
  });

  test("never enables raw HTML for an externally opened file", () => {
    expect(canRenderRawHtml(true, true)).toBe(false);
    expect(canRenderRawHtml(true, false)).toBe(false);
  });
});
```

然后在 `MainWindow.tsx` 调用该函数。这样设置和信任边界可直接单测，避免未来重构时又把 `isExternal` 漏掉。

---

## 6. W4：远程 Markdown 图片默认联网

### 6.1 定位

文件：`src/features/markdown/imageSrc.ts`

当前逻辑对非内部路径直接返回原 `src`：

```ts
if (!imageBaseDir || !normalizedSrc.startsWith(NOTE_IMAGE_PREFIX)) {
  return src;
}
```

因此 Markdown 的：

```md
![tracking pixel](https://tracker.example/pixel.png)
```

会让 WebView 请求远程服务器。请求至少暴露用户 IP、访问时间、User-Agent；URL 本身还可能含唯一标识。它不需要开启原始 HTML，也会影响内部笔记和外部笔记。

### 6.2 修复方案

本地优先产品应该默认不加载远程图片。先不增加设置，直接在解析函数中拒绝 `http:`、`https:` 和协议相对 URL；W1 的 CSP 作为第二道拦截。

```ts
function isRemoteResource(src: string): boolean {
  return /^(?:https?:)?\/\//i.test(src.trim());
}

export function resolveMarkdownImageSrc(
  src: string | undefined,
  imageBaseDir: string | undefined,
  convertFileSrc: FileSrcConverter,
  externalImageBaseDir?: string,
): string {
  if (!src) return "";
  if (isRemoteResource(src)) return "";

  // 保留既有 externalImageBaseDir 与内部 images/ 处理。
  // ...
}
```

同时将组件改为不渲染空图片，避免 broken-image 图标：

```tsx
img: ({ src, alt, ...props }) => {
  const resolvedSrc = resolveMarkdownImageSrc(
    src,
    imageBaseDir,
    convertFileSrc,
    externalImageBaseDir,
  );
  if (!resolvedSrc) {
    return <span className="text-ink-ghost text-sm">[已阻止远程图片]</span>;
  }
  return <img src={resolvedSrc} alt={alt ?? ""} loading="lazy" {...props} />;
},
```

如果未来要恢复远程图片功能，不能只加一个 boolean 后把 CSP 改成 `https:`。更安全的方案是：用户逐域名批准，Rust 后端下载到应用缓存，校验最大大小与 MIME，再从 asset protocol 展示缓存副本。这样第三方服务器仅在用户明确允许时被访问。

### 6.3 测试

在 `imageSrc.test.ts` 增加：

```ts
test("blocks remote and protocol-relative Markdown images", () => {
  expect(
    resolveMarkdownImageSrc("https://tracker.example/pixel.png", "/notes/note-1", convertFileSrc),
  ).toBe("");
  expect(
    resolveMarkdownImageSrc("//tracker.example/pixel.png", "/notes/note-1", convertFileSrc),
  ).toBe("");
  expect(convertFileSrc).not.toHaveBeenCalled();
});
```

保留既有的本地图片、相对外部图片、`..` 逃逸拒绝测试。

---

## 7. W5：外部图片改为应用自有缓存

### 7.1 已实施的路径

外部 Markdown 的父目录不再调用 `allow_directory(parent, true)`。当前链路如下：

1. `external_file_image_base_dir` 只返回外部 Markdown 的 canonical 父目录，不产生 asset protocol 授权。
2. 前端 `MarkdownImage` 仅接受相对图片路径，利用 `resolveExternalRelativeImagePath` 拒绝协议 URL、绝对路径和 `..` 逃逸。
3. 前端把 canonical Markdown 路径与解析后的绝对图片候选路径传给 `cache_external_markdown_image`。
4. Rust 再次 canonicalize Markdown 与图片，使用 `Path::starts_with` 确认图片仍位于 Markdown 父目录之下，阻断前端参数伪造和符号链接逃逸。
5. Rust 复用图片扩展名、普通文件和 50 MB 上限校验，读取图片字节，按 SHA-256 内容哈希写入 `<dataDir>/external-previews/<hash>.<ext>`。
6. Tauri 仅将 app-owned `external-previews` 目录加入 asset scope；WebView 最终通过 `convertFileSrc(cachedPath)` 加载缓存副本。
7. 应用启动时清理上次遗留的 `external-previews`，因此外部图片缓存不会跨重启累积。

核心后端命令位于 `src-tauri/src/lib.rs`：

```rust
#[tauri::command]
fn cache_external_markdown_image(
    markdown_path: String,
    image_path: String,
) -> Result<String, AppError> {
    let markdown = validate_external_text_path(&markdown_path, false)?;
    let canonical_markdown = fs::canonicalize(&markdown)?;
    let parent = canonical_markdown.parent().ok_or_else(|| io_error("外部文件没有有效父目录"))?;

    let canonical_image = fs::canonicalize(PathBuf::from(image_path.trim()))?;
    if !canonical_image.starts_with(parent) {
        return Err(io_error("外部图片必须位于 Markdown 文件所在目录内"));
    }
    validate_image_source_path(&canonical_image.to_string_lossy())?;

    let bytes = fs::read(&canonical_image)?;
    let digest = Sha256::digest(&bytes);
    // 写入 app-owned external-previews，再返回缓存绝对路径。
    // ...
}
```

### 7.2 已否决方案与原因

不能通过“引用计数 + `forbid_directory`”回收权限。Tauri 的 `Scope::forbid_directory` 会向 `forbidden_patterns` 追加规则，并且拒绝规则永久优先于 allow；Scope 没有删除规则的公开 API。

```text
allow_directory(C:\Docs) -> forbid_directory(C:\Docs) -> allow_directory(C:\Docs)
```

最后一次 allow 仍会被之前的 forbid 覆盖，外部图片无法再次显示。这个方案未进入最终实现。

### 7.3 验收条件

- `../secret.png`、绝对路径、`https://host/pixel.png`、协议相对 URL 和符号链接逃逸均被拒绝。
- `./assets/subdir/image.png` 正常显示，且最终 WebView URL 指向应用数据目录的 `external-previews`。
- 用户的外部 Markdown 父目录不会进入 asset protocol scope。
- 重启应用会清理预览缓存；失败时显示“已阻止或无法加载图片”，不回退到外部 `asset://` 路径。

---

## 8. W6：自定义 CSS 是特权功能，必须隔离其网络能力

### 8.1 定位

文件：`src/App.tsx`

当前逻辑将配置内容直接写进应用 `<style>`：

```ts
styleEl = document.createElement("style");
styleEl.id = styleId;
document.head.appendChild(styleEl);
styleEl.textContent = css;
```

设置 UI 也明确说明“将直接注入到应用中”：`src/components/SettingsPanel.tsx`。

### 8.2 判断

这不是普通用户输入导致的漏洞。`customCss` 是本机用户主动配置的高级功能，本来就具备改变应用布局的能力。删除它会伤害产品能力，且无法提高对本地恶意软件的防护。

需要做的是：

1. 用 W1 的 CSP 使其不能通过 `@import`、`url(https://...)` 连接任意网络。
2. 在设置页提示中明确“仅粘贴可信 CSS；CSS 可改变界面和隐藏内容”。
3. 限制最大长度，避免配置意外写入超大内容造成渲染和存储问题。
4. 可选：保存前拒绝 `@import`、`url(http`、`url(//`，作为用户体验提示；这不是安全边界，安全边界仍是 CSP。

### 8.3 可选的长度验证

在 Rust 的 `config_save` 进入持久化前限制大小。建议上限 64 KiB：

```rust
const MAX_CUSTOM_CSS_BYTES: usize = 64 * 1024;

fn validate_config(config: &AppConfig) -> Result<(), AppError> {
    if config.custom_css.len() > MAX_CUSTOM_CSS_BYTES {
        return Err(AppError::new(
            "invalidConfig",
            "自定义 CSS 不能超过 64 KiB",
        ));
    }
    Ok(())
}
```

然后在 `config_save` 最开头调用：

```rust
validate_config(&config)?;
```

这项验证并不替代 CSP，也不应试图用正则解析完整 CSS。

---

## 9. 不应误报的问题

审查文档必须记录哪些防线已存在，避免后续维护者“修复”不存在的问题。

### 9.1 当前没有通用前端文件系统权限

`src-tauri/capabilities/default.json` 只启用了窗口、对话框、剪贴板与 opener 等明确权限。没有 `fs:allow-read-*` / `fs:allow-write-*` 一类通用文件系统 capability。

文件读取/保存由 Rust 自定义命令实现，并使用 `validate_external_text_path` 做格式和大小验证。不要为了“简化 API”而改成暴露通用 fs 插件。

### 9.2 外部相对图片不能用 `..` 逃出父目录

`src/features/markdown/imageSrc.ts` 已按路径段处理 `..`。现有 `imageSrc.test.ts` 覆盖了：

```ts
resolveMarkdownImageSrc("../private.png", undefined, convertFileSrc, "C:/notes/project")
```

并断言不调用 `convertFileSrc`。保留这条测试。

### 9.3 SVG 不是完全未处理

保存到内部笔记库的 SVG 在 `image_payload_matches_extension` 中要求 SVG 根元素且拒绝 `<script`。这不是完整 SVG 消毒器，但结合 `<img>` 加载、W1 CSP 和禁止外部 HTML 渲染，当前风险面已明显收窄。不要因 W1/W2 的整改顺手删掉该校验。

---

## 10. 提交拆分与验收清单

### 提交 A：恢复 CSP 与阻止远程图片

建议提交信息：

```text
fix(security): enforce offline WebView CSP and block remote Markdown images
```

文件：

- `src-tauri/tauri.conf.json`
- `src/features/markdown/imageSrc.ts`
- `src/features/markdown/MarkdownPreview.tsx`
- `src/features/markdown/imageSrc.test.ts`

验收：`npm test`、`npx tsc --noEmit`、`npm run lint`、`npm run tauri build -- --bundles nsis`，以及真实窗口网络请求检查。

### 提交 B：收紧原始 HTML 与外部文件渲染策略

建议提交信息：

```text
fix(security): isolate raw HTML rendering from externally opened files
```

文件：

- `src/features/markdown/MarkdownPreview.tsx`
- `src/features/markdown/MarkdownPreview.test.tsx`
- `src/features/markdown/renderPolicy.ts`
- `src/features/markdown/renderPolicy.test.ts`
- `src/components/MainWindow.tsx`

验收：默认内部 Markdown、开启 HTML 的内部笔记、开启 HTML 后的外部 `.md` / `.html`、KaTeX、标题锚点、wiki link、图片路径全部手测。

### 提交 C：以受控缓存替换外部目录 asset scope

建议提交信息：

```text
fix(security): cache approved external Markdown images locally
```

文件：

- `src-tauri/src/lib.rs` 或独立 `services/external_images.rs`
- `src/features/markdown/imageSrc.ts`
- `src/features/markdown/MarkdownPreview.tsx`
- 对应 Rust 与前端测试

验收：连续打开不同目录的外部文件、同目录两份外部文件、切回内部笔记、关闭窗口后重新打开外部文件。确认相对图片来自应用缓存，外部目录从未被递归加入 asset scope。

---

## 11. 回归测试 payload

仅在隔离数据目录和开发环境中使用。不要把以下内容保存进真实笔记库后忘记删除。

```md
# 安全回归

![远程像素](https://example.invalid/pixel.png)

<script>document.title = "pwned"</script>

<img src="x" onerror="alert(1)">

<p style="position:fixed;inset:0;z-index:99999;background:white">遮挡</p>

<iframe src="https://example.invalid"></iframe>
```

预期结果：

- 外部图片不请求网络，显示“已阻止远程图片”或不渲染。
- `<script>`、`onerror`、`iframe` 不进入最终 DOM。
- 内联 `style` 被移除，界面不被遮挡。
- 当文件来自外部路径，即使用户设置开启 HTML，也只按安全 Markdown 渲染。
- 控制台无 CSP 误拦截合法静态资源。

---

## 12. 参考依据

- Tauri v2 Content Security Policy：<https://v2.tauri.app/security/csp/>
- Tauri v2 Asset protocol scope：<https://v2.tauri.app/security/asset-protocol/>
- Tauri capability / permissions：<https://v2.tauri.app/security/permissions/>
- `rehype-sanitize`：<https://github.com/rehypejs/rehype-sanitize>

`rehype-sanitize` 的关键原则是：对所有不可信内容使用白名单消毒，并保证 sanitizer 位于最后一个不可信 AST 变换之后。花笺目前使用 `rehypeRaw -> rehypeSanitize -> rehypeKatex -> rehypeSlug`；后两个插件属于项目受控依赖，但升级它们时仍应将本文件的回归 payload 加入验证。
