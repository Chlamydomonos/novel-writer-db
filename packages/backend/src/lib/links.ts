/**
 * Markdown 链接的纯文本解析与路径编解码工具。
 *
 * 职责边界：本模块**只做纯字符串计算，不访问数据库**。"链接目标是否存在"
 * 的判定在 `lib/novel.ts` 中基于 `Document`/`Category` 表完成。
 *
 * 支持的链接语法：
 * - 行内链接 `[文本](目标)`（含可选标题 `[文本](目标 "标题")`）与图片 `![替代文本](目标)`；
 * - 引用式链接（`[文本][引用]`）与自动链接（`<目标>`、裸 URL）**不在支持范围内**。
 *
 * 目标（target）处理规则：
 * - 跳过带协议前缀的外部链接（`http://`、`https://`、`mailto:` 等）与纯锚点（`#xxx`）；
 * - 剥离 `#fragment` 与 `?query` 后再做路径解析；
 * - 百分号编码会被解码（`%20` → 空格）；解码失败时按原文处理；
 * - 相对路径以**源文档所在目录**为基准解析（`./`、`../`、裸文件名均视为相对路径）；
 * - 归一化为绝对路径后，仅保留以 `.md` 结尾的目标（其余类型如图片、外部页面直接忽略）。
 */

/** 行内链接正则：同时匹配超链接与图片；兼容 `[文本](目标 "标题")` 形式。 */
const INLINE_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** 单个链接匹配结果（含在原文中的位置，便于重写正文）。 */
export interface LinkMatch {
    /** 解码后的目标 `path`（已剥离 fragment/query）；无法解析的外部/空目标为 `null`。 */
    path: string | null;
    /**
     * 原始目标形态（仅当 `path !== null` 时有意义）：
     * - `'absolute'`：以 `/` 开头的绝对路径；
     * - `'relative'`：其余可解析目标（`./x.md`、`../x.md`、`x.md`）。
     */
    kind: 'absolute' | 'relative';
    /** 原始 href 文本（未解码，如 `%20` 原样保留）。 */
    href: string;
    /** 匹配在原文中的起始下标。 */
    index: number;
    /** 匹配的完整原文（`[文本](目标)` 或 `![替代](目标)`）。 */
    raw: string;
}

/**
 * 扫描文本中的全部行内链接。
 *
 * 不做存在性检查、不做 `.md` 过滤——由调用方按需处理。
 */
export function collectLinkMatches(text: string): LinkMatch[] {
    const matches: LinkMatch[] = [];
    for (const match of text.matchAll(INLINE_LINK_RE)) {
        const href = match[3];
        if (href === undefined) continue;

        const index = match.index;
        const raw = match[0];
        if (index === undefined || raw === undefined) continue;

        const parsed = parseHref(href);
        // 外部协议/锚点/空目标 → 保留为不可解析匹配（path=null），供重写时整体跳过。
        matches.push({
            path: parsed?.path ?? null,
            kind: parsed?.kind ?? 'absolute',
            href,
            index,
            raw,
        });
    }
    return matches;
}

/** 解码百分号编码。解码失败（如编码序列非法）时返回原文。 */
function safeDecode(href: string): string {
    try {
        return decodeURIComponent(href);
    } catch {
        return href;
    }
}

interface ParsedHref {
    path: string;
    kind: 'absolute' | 'relative';
}

/**
 * 把链接 href 归一化成 `{ path, kind }`：
 * - 跳过 `null`（外部协议、纯锚点、空目标）；
 * - 剥离 fragment/query，解码百分号编码；
 * - `kind` 标记绝对（`/` 开头）或相对。
 */
function parseHref(href: string): ParsedHref | null {
    if (href.length === 0) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null; // http: mailto: 等外部协议
    if (href.startsWith('#')) return null; // 纯文档内锚点

    // 剥离 fragment 与 query
    const fragmentIdx = href.indexOf('#');
    const queryIdx = href.indexOf('?');
    let cut = href.length;
    if (fragmentIdx >= 0) cut = Math.min(cut, fragmentIdx);
    if (queryIdx >= 0) cut = Math.min(cut, queryIdx);

    const path = safeDecode(href.slice(0, cut));
    if (path.length === 0) return null;

    return { path, kind: path.startsWith('/') ? 'absolute' : 'relative' };
}

/**
 * 以源文档所在目录 `sourceDir`（形如 `/设定/世界`）为基准，把已解码的
 * `path`（形如 `./xxx.md`、`../设定/xxx.md` 或 `/设定/xxx.md`）解析为
 * 绝对路径（如 `/设定/世界/xxx.md`）。
 *
 * 无法解析时返回 `null`（如 `..` 越出根目录）。
 */
export function resolveLinkPath(path: string, sourceDir: string): string | null {
    if (path.startsWith('/')) {
        return normalizePathSegments(path);
    }

    const baseSegments = sourceDir.split('/').filter((s) => s.length > 0);
    const stack: string[] = [...baseSegments];

    for (const segment of path.split('/')) {
        if (segment.length === 0 || segment === '.') continue;
        if (segment === '..') {
            if (stack.length === 0) return null; // 越出根目录
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    if (stack.length === 0) return null;

    return `/${stack.join('/')}`;
}

/** 绝对路径的段归一化（折叠 `.`/`..`，`..` 越界时丢弃该段）。 */
function normalizePathSegments(path: string): string | null {
    const stack: string[] = [];
    for (const segment of path.split('/')) {
        if (segment.length === 0 || segment === '.') continue;
        if (segment === '..') {
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    if (stack.length === 0) return null;
    return `/${stack.join('/')}`;
}

/**
 * 计算从目录 `fromDir`（形如 `/设定/世界`）到绝对路径 `target`（形如 `/大纲/x.md`）
 * 的相对路径（如 `x.md`、`sub/y.md`、`../../大纲/x.md`）。
 *
 * 仅用于移动文档时**保留相对写法**地重写链接；两个路径都要求形如以 `/` 开头。
 */
export function relativeHrefFrom(fromDir: string, target: string): string {
    const fromParts = fromDir.split('/').filter((s) => s.length > 0);
    const targetParts = target.split('/').filter((s) => s.length > 0);
    const fileName = targetParts.at(-1) ?? '';
    const targetDirParts = targetParts.slice(0, -1);

    // 计算共同前缀长度
    let common = 0;
    while (
        common < fromParts.length &&
        common < targetDirParts.length &&
        fromParts[common] === targetDirParts[common]
    ) {
        common++;
    }

    const ups = fromParts.length - common;
    const segments: string[] = [];
    for (let i = 0; i < ups; i++) segments.push('..');
    for (let i = common; i < targetDirParts.length; i++) {
        const part = targetDirParts[i];
        if (part !== undefined) segments.push(part);
    }
    segments.push(fileName);

    return segments.join('/');
}

/**
 * 把绝对路径编码为可安全放入 Markdown 链接的 href：
 * 百分号、空白、括号、`#`、`?` 与控制符会被转义；中文等非 ASCII 字符保持原样。
 */
export function encodeLinkHref(path: string): string {
    // 先转义字面量 `%`，避免与后续转义产生的编码序列混淆
    let out = path.replace(/%/g, '%25');
    // 转义会破坏行内链接语法（`[^)\s]+`）的字符：空白与控制符
    out = out.replace(/[\s\u0000-\u001F\u007F]/g, (ch) => encodeURIComponent(ch));
    // Markdown 链接目标中会造成歧义的字符
    out = out.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/#/g, '%23').replace(/\?/g, '%3F');
    return out;
}

/**
 * 判断绝对路径是否可视为"文档路径"：
 * 形如 `/<根目录>/…/xxx.md`（至少两级且以 `.md` 结尾）。链接筛选据此进行。
 */
export function isDocumentPath(path: string): boolean {
    const parts = path.split('/').filter((s) => s.length > 0);
    if (parts.length < 2) return false;
    const name = parts.at(-1) ?? '';
    return name.endsWith('.md');
}

/**
 * 逐个重写正文中的链接目标，保留链接文本与标题等其余部分原样。
 *
 * `rewrite` 收到**解码后的目标**与原始形态；返回 `null` 表示该处保持不变，
 * 返回字符串则作为新目标（会被 `encodeLinkHref` 编码后填回 `[文本](目标)` 中）。
 *
 * 若没有任何匹配被重写，原样返回输入字符串（便于调用方判断是否变化）。
 */
export function rewriteTextLinks(
    text: string,
    rewrite: (path: string, kind: 'absolute' | 'relative') => string | null,
): string {
    const matches = collectLinkMatches(text);
    let out = '';
    let cursor = 0;

    for (const match of matches) {
        if (match.path === null) continue;
        const replacement = rewrite(match.path, match.kind);
        if (replacement === null) continue;

        // 从 raw 中拆出 `[文本](` 与目标后的尾部（`)` 或 ` "标题")`），只替换目标部分
        const openIdx = match.raw.indexOf('](');
        const head = match.raw.slice(0, openIdx + 2); // 含 `](`
        const tail = match.raw.slice(openIdx + 2 + match.href.length);

        out += text.slice(cursor, match.index) + head + encodeLinkHref(replacement) + tail;
        cursor = match.index + match.raw.length;
    }

    if (cursor === 0) return text; // 没有任何匹配被重写
    out += text.slice(cursor);
    return out;
}
