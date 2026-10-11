import { Op, type Transaction } from '@sequelize/core';
import { DELETED_LINK_TARGET, ROOT_CATEGORY_NAMES, type RootCategoryName } from '@novel-writer/shared';
import { getChroma } from './db/chroma.js';
import { embeddingFunction } from './db/embedding.js';
import { Category } from './db/models/category.js';
import { Document } from './db/models/document.js';
import { DocumentLink } from './db/models/document-link.js';
import { Novel as NovelModel } from './db/models/novel.js';
import { getDB } from './db/sequelize.js';
import { EditFailError, ExistError, InvalidPathError, NotExistError, OutOfBoundsError } from './errors.js';
import { collectLinkMatches, isDocumentPath, relativeHrefFrom, resolveLinkPath, rewriteTextLinks } from './links.js';

// 从 @novel-writer/shared 再导出，便于现有 `import { RootCategoryName } from '../lib/novel.js'` 调用方继续工作。
export type { RootCategoryName } from '@novel-writer/shared';
export { ROOT_CATEGORY_NAMES };

export class Novel {
    private constructor(
        readonly id: number,
        private _name: string,
        private _info: string,
    ) {}

    get name() {
        return this._name;
    }

    get info() {
        return this._info;
    }

    // 通过ID获取小说。该接口不暴露给LLM
    static async byID(id: number) {
        const model = await NovelModel.findByPk(id);
        if (!model) {
            throw new NotExistError(`ID为${id}的小说不存在`);
        }

        return new Novel(model.id, model.name, model.info);
    }

    // 列出所有小说。该接口不暴露给LLM
    static async listAll() {
        const list = await NovelModel.findAll();
        return list.map((m) => ({ id: m.id as number, name: m.name as string }));
    }

    // 创建小说。该接口不暴露给LLM
    static async create(name: string) {
        const db = await getDB();

        const existing = await NovelModel.findOne({ where: { name } });
        if (existing) {
            throw new ExistError(`名称为${name}的小说已经存在`);
        }

        const { model, settings, outlines, texts } = await db.transaction(async (transaction) => {
            const model = await NovelModel.create({ name }, { transaction });
            const settings = await Category.create({ name: '设定', novelId: model.id }, { transaction });
            const outlines = await Category.create({ name: '大纲', novelId: model.id }, { transaction });
            const texts = await Category.create({ name: '正文', novelId: model.id }, { transaction });

            return { model, settings, outlines, texts };
        });

        const chroma = await getChroma();
        await chroma.createCollection({ name: `category_${settings.id}`, embeddingFunction });
        await chroma.createCollection({ name: `category_${outlines.id}`, embeddingFunction });
        await chroma.createCollection({ name: `category_${texts.id}`, embeddingFunction });

        return new Novel(model.id, model.name, '');
    }

    private async findCategory(path: string) {
        if (!path.startsWith('/')) {
            throw new InvalidPathError('路径必须为绝对路径');
        }

        const splitted = path.split('/').filter((p) => p.length > 0);
        if (splitted.length == 0) {
            throw new InvalidPathError('必须选择一个根目录（`/设定`，`/大纲`或`/正文`）');
        }

        for (const item of splitted) {
            if (item.includes('.')) {
                throw new InvalidPathError('目录中不能含有`.`');
            }
        }

        let partialPath = '';
        let currentId: number | undefined = undefined;
        let rootId: number | undefined = undefined;

        for (let i = 0; i < splitted.length; i++) {
            partialPath += `/${splitted[i]}`;

            let model: Category | null;
            if (currentId) {
                model = await Category.findOne({ where: { parentId: currentId, name: splitted[i] } });
            } else {
                model = await Category.findOne({ where: { novelId: this.id, name: splitted[i] } });
            }

            if (!model) {
                throw new NotExistError(`目录\`${partialPath}\`不存在`);
            }
            currentId = model.id;
            if (!rootId) {
                rootId = model.id;
            }
        }

        return { rootId: rootId!, id: currentId! };
    }

    // ===========================================================================
    // 文档路径解析与 Markdown 链接维护（私有辅助）
    // ===========================================================================

    // 解析并校验 `.md` 文档路径（供写入/移动/删除等操作复用）。
    private parseDocumentPath(path: string, action: string) {
        if (!path.startsWith('/')) {
            throw new InvalidPathError('路径必须为绝对路径');
        }

        const splitted = path.split('/').filter((p) => p.length > 0);
        if (splitted.length < 2) {
            throw new InvalidPathError(`无效的路径: ${path}`);
        }

        const dirNames = splitted.slice(0, -1);
        const name = splitted.at(-1)!;
        if (!name.endsWith('.md')) {
            throw new InvalidPathError(`只能${action}\`.md\`文件`);
        }

        return { dirNames, dirPath: '/' + dirNames.join('/'), name };
    }

    // 宽容地检查"某绝对路径对应的文档是否真实存在"：
    // 目录链或文档不存在时静默返回 false（与会抛错的 findCategory 不同），供链接解析使用。
    private async linkTargetExists(target: string, transaction: Transaction) {
        if (!isDocumentPath(target)) {
            return false;
        }

        const parts = target.split('/').filter((p) => p.length > 0);
        const name = parts.at(-1)!;

        let currentId: number | undefined = undefined;
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i]!;
            let model: Category | null;
            if (currentId === undefined) {
                model = await Category.findOne({ where: { novelId: this.id, name: dirName }, transaction });
            } else {
                model = await Category.findOne({ where: { parentId: currentId, name: dirName }, transaction });
            }
            if (!model) {
                return false;
            }
            currentId = model.id;
        }

        const document = await Document.findOne({ where: { categoryId: currentId!, name }, transaction });
        return document !== null;
    }

    // 解析文档正文中的 Markdown 链接，整体替换该文档的链接记录（DocumentLink）。
    //
    // 解析规则：行内链接 `[文本](目标)`（含图片 `![替代](目标)`）；
    // 仅保留**指向 `.md` 文件且目标文档真实存在**的链接，其余（外部 URL、锚点、
    // 不存在的相对路径等）一律忽略。相对路径以源文档所在目录 `sourceDir` 为基准解析。
    // 同一目标多次出现时去重存储。
    private async syncDocumentLinks(documentId: number, sourceDir: string, text: string, transaction: Transaction) {
        const targets = new Set<string>();
        for (const match of collectLinkMatches(text)) {
            if (match.path === null) {
                continue;
            }
            const absolute = resolveLinkPath(match.path, sourceDir);
            if (absolute === null || !isDocumentPath(absolute)) {
                continue;
            }
            if (targets.has(absolute)) {
                continue;
            }
            if (await this.linkTargetExists(absolute, transaction)) {
                targets.add(absolute);
            }
        }

        await DocumentLink.destroy({ where: { documentId }, transaction });
        if (targets.size > 0) {
            await DocumentLink.bulkCreate(
                [...targets].map((target) => ({ documentId, target })),
                { transaction },
            );
        }
    }

    // 找到某个 Category 所属根目录（拥有 `novelId` 的那条 Category）的 ID。
    private async findRootCategoryId(categoryId: number) {
        let currentId: number | undefined = categoryId;
        for (;;) {
            const model: Category | null = await Category.findByPk(currentId);
            if (!model) {
                throw new Error('查找根目录时发生未知错误');
            }
            if (model.novelId != null) {
                return model.id;
            }
            if (model.parentId == null) {
                throw new Error('查找根目录时发生未知错误');
            }
            currentId = model.parentId;
        }
    }

    // 重命名小说。该接口不暴露给LLM
    async rename(newName: string) {
        const model = await NovelModel.findByPk(this.id);
        if (!model) {
            throw new NotExistError(`ID为${this.id}的小说不存在`);
        }

        model.name = newName;
        await model.save();
        this._name = newName;
        return this;
    }

    // 修改小说基本信息
    async writeInfo(newInfo: string) {
        const model = await NovelModel.findByPk(this.id);
        if (!model) {
            throw new NotExistError(`ID为${this.id}的小说不存在`);
        }

        model.info = newInfo;
        await model.save();
        this._info = newInfo;
        return this;
    }

    // 以正则表达式替换的形式修改小说基本信息
    async editInfo(regex: string, replace: string, flags?: string) {
        const newInfo = this._info.replace(new RegExp(regex, flags), replace);
        if (newInfo == this._info) {
            throw new EditFailError('编辑后的字符串与原字符串相同');
        }
        return await this.writeInfo(newInfo);
    }

    // 删除小说。该接口不暴露给LLM
    async destroy() {
        const rootCategories = await Category.findAll({ where: { novelId: this.id } });
        const rootCategoryIds = rootCategories.map((c) => c.id);

        const db = await getDB();
        await db.transaction(async (transaction) => {
            const model = await NovelModel.findByPk(this.id);
            if (model) {
                await model.destroy({ transaction });
            }
        });

        // ChromaDB 不参与 Sequelize 事务，删除在事务提交后尽力清理。
        const chroma = await getChroma();
        for (const rootCategoryId of rootCategoryIds) {
            try {
                await chroma.deleteCollection({ name: `category_${rootCategoryId}` });
            } catch {
                // collection 可能不存在或已被删除，忽略以便主流程完成。
            }
        }
    }

    // 列出某一路径下的所有内容
    // 返回一个多行的字符串，每一行以 `| ` 缩进表示目录层级，以开头的emoji表示目录项类型
    // 🗂️表示非空目录，📁表示空目录，📂表示内容未知的目录，📄表示文件
    // recursive=true 时采用广度优先遍历，条目总数超过 50 后自动截断（非空目录改为📂不再深入）
    async list(path: string, recursive: boolean) {
        const { id: startId } = await this.findCategory(path);

        if (!recursive) {
            const categories = await Category.findAll({ where: { parentId: startId } });
            const documents = await Document.findAll({ where: { categoryId: startId } });

            const lines: string[] = [];
            for (const c of categories) {
                lines.push(`📂 ${c.name}`);
            }
            for (const d of documents) {
                lines.push(`📄 ${d.name}`);
            }
            return lines.join('\n') + (lines.length > 0 ? '\n' : '');
        }

        // ---- 广度优先遍历发现节点，构建树结构后用深度优先输出 ----
        // BFS 确保条目数达上限后截断的语义正确（先到先得），
        // 树 + DFS 确保子节点出现在父节点之下。
        const MAX_ENTRIES = 50;

        type TreeNode = { icon: string; name: string; children: TreeNode[] };

        const root: TreeNode = { icon: '', name: '', children: [] };
        const queue: { parentNode: TreeNode; categoryId: number }[] = [];
        let entryCount = 0;
        let capped = false;

        const processNode = async (categoryId: number, parentNode: TreeNode) => {
            const childCategories = await Category.findAll({ where: { parentId: categoryId } });
            const childDocuments = await Document.findAll({ where: { categoryId } });

            for (const cat of childCategories) {
                if (entryCount >= MAX_ENTRIES) capped = true;

                if (capped) {
                    const hasContent =
                        (await Category.count({ where: { parentId: cat.id } })) > 0 ||
                        (await Document.count({ where: { categoryId: cat.id } })) > 0;
                    parentNode.children.push({
                        icon: hasContent ? '📂' : '📁',
                        name: cat.name,
                        children: [],
                    });
                } else {
                    const hasContent =
                        (await Category.count({ where: { parentId: cat.id } })) > 0 ||
                        (await Document.count({ where: { categoryId: cat.id } })) > 0;

                    const node: TreeNode = { icon: '', name: cat.name, children: [] };
                    parentNode.children.push(node);

                    if (hasContent) {
                        node.icon = '🗂️';
                        queue.push({ parentNode: node, categoryId: cat.id });
                    } else {
                        node.icon = '📁';
                    }
                }
                entryCount++;
            }

            for (const doc of childDocuments) {
                if (entryCount >= MAX_ENTRIES) capped = true;
                parentNode.children.push({ icon: '📄', name: doc.name, children: [] });
                entryCount++;
            }
        };

        await processNode(startId, root);

        while (queue.length > 0) {
            const { parentNode, categoryId } = queue.shift()!;
            await processNode(categoryId, parentNode);
        }

        // 深度优先输出
        const lines: string[] = [];
        const dfs = (node: TreeNode, depth: number) => {
            for (const child of node.children) {
                const indent = depth > 0 ? '| '.repeat(depth) : '';
                lines.push(`${indent}${child.icon} ${child.name}`);
                dfs(child, depth + 1);
            }
        };
        dfs(root, 0);

        return lines.join('\n') + (lines.length > 0 ? '\n' : '');
    }

    // 以Json格式列出某一路径下的所有内容。该接口不暴露给LLM
    async listAsJson(path: string) {
        const { id } = await this.findCategory(path);
        const categories = await Category.findAll({ where: { parentId: id } });
        const documents = await Document.findAll({ where: { categoryId: id } });
        return [
            ...categories.map((c) => ({ type: 'category' as const, name: c.name })),
            ...documents.map((d) => ({ type: 'document' as const, name: d.name })),
        ];
    }

    // 读取指定文件的内容
    async read(paths: string[]) {
        if (paths.length == 0) {
            throw new OutOfBoundsError('至少提供一个文件路径');
        }

        const parsedPaths: { categoryPath: string; name: string }[] = [];
        for (const path of paths) {
            if (!path.startsWith('/')) {
                throw new InvalidPathError('路径必须为绝对路径');
            }

            const splitted = path.split('/').filter((p) => p.length > 0);
            if (splitted.length < 2) {
                throw new InvalidPathError(`无效的路径: ${path}`);
            }

            const categoryPath = '/' + splitted.slice(0, -1).join('/');
            const name = splitted.at(-1)!;
            if (!name.endsWith('.md')) {
                throw new InvalidPathError('只能读取`.md`文件');
            }

            parsedPaths.push({ categoryPath, name: name });
        }

        const chroma = await getChroma();
        const results: { path: string; text: string }[] = [];
        for (const parsed of parsedPaths) {
            const { id: categoryId, rootId } = await this.findCategory(parsed.categoryPath);
            const document = await Document.findOne({ where: { categoryId, name: parsed.name } });
            if (!document) {
                throw new NotExistError(`文档\`${parsed.categoryPath}/${parsed.name}不存在\``);
            }
            const collection = await chroma.getCollection({ name: `category_${rootId}`, embeddingFunction });
            const text = (await collection.get({ ids: [document.id.toString()] })).documents[0];
            if (text === undefined || text === null) {
                throw new NotExistError(`文档\`${parsed.categoryPath}/${parsed.name}不存在\``);
            }
            results.push({ path: `/${parsed.categoryPath}/${parsed.name}`, text });
        }

        return results;
    }

    private async getCategoryPath(categoryId: number) {
        let reversedNameList: string[] = [];
        let currentId: number | undefined = categoryId;
        while (currentId) {
            const model: Category | null = await Category.findByPk(currentId);
            if (!model) {
                throw new Error('拼接路径时发生未知错误');
            }

            reversedNameList.push(model.name);
            currentId = model.parentId;
        }

        let path = '';
        for (let i = reversedNameList.length - 1; i >= 0; i--) {
            path += `/${reversedNameList[i]}`;
        }

        return path;
    }

    private async getDocumentPath(documentId: number) {
        const model = await Document.findByPk(documentId);
        if (!model) {
            throw new NotExistError(`ID为${documentId}的文档不存在`);
        }

        return `${await this.getCategoryPath(model.categoryId)}/${model.name}`;
    }

    // 通过语义搜索查找文件
    async search(rootCategory: RootCategoryName, texts: string[], limit: number) {
        if (limit > 20 || limit < 1) {
            throw new OutOfBoundsError('limit应该在1和20之间');
        }

        if (texts.length == 0) {
            throw new OutOfBoundsError('至少提供一个搜索关键词');
        }

        const categoryModel = await Category.findOne({ where: { novelId: this.id, name: rootCategory } });
        if (!categoryModel) {
            throw new NotExistError(`根目录${rootCategory}不存在`);
        }

        const chroma = await getChroma();
        const collection = await chroma.getCollection({ name: `category_${categoryModel.id}`, embeddingFunction });
        const searchResult = await collection.query({ queryTexts: texts, nResults: limit });
        const result: { path: string; text: string }[] = [];
        const idSet = new Set<number>();
        const documentMap: Record<number, string> = {};
        for (let i = 0; i < searchResult.documents.length; i++) {
            const documents = searchResult.documents[i];
            const ids = searchResult.ids[i];
            if (!documents || !ids) {
                continue;
            }

            for (let j = 0; j < documents.length; j++) {
                const idStr = ids[j];
                const document = documents[j];
                if (!idStr || !document) {
                    continue;
                }

                const id = parseInt(idStr);
                if (isNaN(id)) {
                    continue;
                }

                if (idSet.has(id)) {
                    continue;
                }

                idSet.add(id);
                documentMap[id] = document;
            }
        }

        for (const id of idSet) {
            const text = documentMap[id];
            if (!text) {
                throw new Error('整理文档列表时发生未知错误');
            }

            const path = await this.getDocumentPath(id);
            result.push({ path, text });
        }

        return result;
    }

    // 写入文件，自动创建目录
    // 只能在`/设定`，`/大纲`，`/正文`这三个根目录中写入文件
    async write(path: string, text: string): Promise<{ documentId: number }> {
        if (!path.startsWith('/')) {
            throw new InvalidPathError('路径必须为绝对路径');
        }

        const splitted = path.split('/').filter((p) => p.length > 0);
        if (splitted.length < 2) {
            throw new InvalidPathError(`无效的路径: ${path}`);
        }

        const categoryNames = splitted.slice(0, -1);
        const name = splitted.at(-1)!;
        if (!name.endsWith('.md')) {
            throw new InvalidPathError('只能写入`.md`文件');
        }

        const db = await getDB();
        const { documentId, rootCategoryId } = await db.transaction(async (transaction) => {
            let currentCategoryId: number | undefined = undefined;
            let rootCategoryId: number | undefined = undefined;
            for (const categoryName of categoryNames) {
                let model: Category | null;
                if (currentCategoryId) {
                    model = await Category.findOne({ where: { parentId: currentCategoryId, name: categoryName } });
                } else {
                    model = await Category.findOne({ where: { novelId: this.id, name: categoryName } });
                    if (!model) {
                        throw new InvalidPathError(`不能写入根目录${categoryName}`);
                    }
                    rootCategoryId = model.id;
                }

                if (!model) {
                    model = await Category.create(
                        { parentId: currentCategoryId!, name: categoryName },
                        { transaction },
                    );
                }

                currentCategoryId = model.id;
            }

            let model = await Document.findOne({ where: { categoryId: currentCategoryId!, name } });
            if (!model) {
                model = await Document.create({ categoryId: currentCategoryId!, name }, { transaction });
            }

            // 自动解析正文中的 Markdown 链接并更新链接记录
            // （创建/编辑共用此入口：正则编辑 edit() 也经由 write 写回）。
            await this.syncDocumentLinks(model.id, '/' + categoryNames.join('/'), text, transaction);

            return { documentId: model.id, rootCategoryId: rootCategoryId! };
        });

        const chroma = await getChroma();
        const collection = await chroma.getCollection({ name: `category_${rootCategoryId}`, embeddingFunction });
        await collection.upsert({ ids: [documentId.toString()], documents: [text] });

        return { documentId };
    }

    // ===========================================================================
    // 移动文档（含重命名）：自动把指向旧路径的链接改指新位置
    // ===========================================================================

    // 将文档从 `from` 移动到 `to`（可同时换目录与改名），目标目录不存在时自动创建。
    // 同一事务内完成：目标目录创建 → 重名检查 → 入链正文重写 → 文档行更新 → 链接记录同步；
    // 事务提交后再迁移 ChromaDB 向量并重嵌入被改写正文的文档。
    // 返回被改写指向新位置的链接记录数。该接口暴露给 LLM（MCP `move_document`）。
    async moveDocument(from: string, to: string): Promise<{ from: string; to: string; updatedLinks: number }> {
        if (from === to) {
            throw new InvalidPathError('源路径与目标路径相同');
        }

        const src = this.parseDocumentPath(from, '移动');
        const dst = this.parseDocumentPath(to, '移动');

        const { id: srcCategoryId, rootId: srcRootId } = await this.findCategory(src.dirPath);
        const srcDoc = await Document.findOne({ where: { categoryId: srcCategoryId, name: src.name } });
        if (!srcDoc) {
            throw new NotExistError(`文档\`${from}\`不存在`);
        }
        const documentId = srcDoc.id;

        // 取旧正文（自身相对链接换算、自链接重写都需要）。
        const chroma = await getChroma();
        const oldCollection = await chroma.getCollection({ name: `category_${srcRootId}`, embeddingFunction });
        const oldDoc = (await oldCollection.get({ ids: [documentId.toString()] })).documents[0];
        const oldText = typeof oldDoc === 'string' ? oldDoc : '';
        const hasVector = typeof oldDoc === 'string';

        const db = await getDB();
        const { dstDirPath, dstRootId, selfText, rewrites, updatedLinks } = await db.transaction(
            async (transaction) => {
                // 1) 逐级查找/创建目标目录链（根目录必须已存在，语义与 write 一致）
                let currentCategoryId: number | undefined = undefined;
                let rootCategoryId: number | undefined = undefined;
                for (const dirName of dst.dirNames) {
                    let model: Category | null;
                    if (currentCategoryId === undefined) {
                        model = await Category.findOne({ where: { novelId: this.id, name: dirName }, transaction });
                        if (!model) {
                            throw new InvalidPathError(`根目录\`${dirName}\`不存在`);
                        }
                        rootCategoryId = model.id;
                    } else {
                        model = await Category.findOne({
                            where: { parentId: currentCategoryId, name: dirName },
                            transaction,
                        });
                        if (!model) {
                            model = await Category.create(
                                { parentId: currentCategoryId, name: dirName },
                                { transaction },
                            );
                        }
                    }
                    currentCategoryId = model.id;
                }
                const dstDirPath = '/' + dst.dirNames.join('/');

                // 2) 重名检查（源文档自身即将离开原位置，不影响目标位置的重名判定）
                const existing = await Document.findOne({
                    where: { categoryId: currentCategoryId!, name: dst.name },
                    transaction,
                });
                if (existing) {
                    throw new ExistError(`文档\`${to}\`已存在`);
                }

                // 3) 汇总所有指向旧路径的入链记录，按源文档去重
                const inboundLinks = await DocumentLink.findAll({ where: { target: from }, transaction });
                const updatedLinks = inboundLinks.length;
                const inboundDocIds = [...new Set(inboundLinks.map((l) => l.documentId))];

                // 4) 重写各入链文档的正文（源文档自身指向旧路径的自链接由下一步统一处理）
                const rewrites: { documentId: number; rootId: number; text: string }[] = [];
                for (const inboundDocId of inboundDocIds) {
                    if (inboundDocId === documentId) {
                        continue; // 自链接在自身重写中处理，避免双重改写
                    }
                    const doc = await Document.findByPk(inboundDocId, { transaction });
                    if (!doc) {
                        continue;
                    }
                    const dirPath = await this.getCategoryPath(doc.categoryId);
                    const rootId = await this.findRootCategoryId(doc.categoryId);

                    const collection = await chroma.getCollection({ name: `category_${rootId}`, embeddingFunction });
                    const text = (await collection.get({ ids: [inboundDocId.toString()] })).documents[0] ?? '';

                    const newText = rewriteTextLinks(text, (target, kind) => {
                        if (target !== from) {
                            return null;
                        }
                        // 绝对写法直接换新绝对路径；相对写法换算成相对新位置的相对路径，保留原风格
                        return kind === 'absolute' ? to : relativeHrefFrom(dirPath, to);
                    });
                    if (newText !== text) {
                        rewrites.push({ documentId: inboundDocId, rootId, text: newText });
                    }
                }

                // 5) 重写自身正文：指向旧路径的链接（自链接）改指新位置；
                //    其余相对链接换算成相对新目录的写法，保证解析结果（绝对目标）不变。
                const selfText = rewriteTextLinks(oldText, (target, kind) => {
                    if (target === from) {
                        return kind === 'absolute' ? to : relativeHrefFrom(dstDirPath, to);
                    }
                    if (kind === 'relative') {
                        return relativeHrefFrom(dstDirPath, target);
                    }
                    return null; // 绝对链接且指向其他文档：保持不变
                });

                // 6) 更新文档行（先于链接同步：sync 校验 `to` 存在性时需要新位置已就位）
                const model = await Document.findByPk(documentId, { transaction });
                if (!model) {
                    throw new Error('移动文档时发生未知错误');
                }
                model.categoryId = currentCategoryId!;
                model.name = dst.name;
                await model.save({ transaction });

                // 7) 同步自身与各入链文档的链接记录
                await this.syncDocumentLinks(documentId, dstDirPath, selfText, transaction);
                for (const r of rewrites) {
                    // 入链文档自身的目录未变，以其所在目录为基准重解析
                    const doc = await Document.findByPk(r.documentId, { transaction });
                    if (!doc) {
                        continue;
                    }
                    const dirPath = await this.getCategoryPath(doc.categoryId);
                    await this.syncDocumentLinks(r.documentId, dirPath, r.text, transaction);
                }

                return {
                    dstDirPath,
                    dstRootId: rootCategoryId!,
                    selfText,
                    rewrites,
                    updatedLinks,
                };
            },
        );

        // 事务提交后：迁移 ChromaDB（正文不在 Sequelize 中，不参与事务）。
        // 被移动文档先从旧 collection 删除，再写入新 collection；正文被改写的入链文档重嵌入。
        if (hasVector) {
            await oldCollection.delete({ ids: [documentId.toString()] });
            const newCollection = await chroma.getCollection({ name: `category_${dstRootId}`, embeddingFunction });
            await newCollection.upsert({ ids: [documentId.toString()], documents: [selfText] });
        }
        for (const r of rewrites) {
            const collection = await chroma.getCollection({ name: `category_${r.rootId}`, embeddingFunction });
            await collection.upsert({ ids: [r.documentId.toString()], documents: [r.text] });
        }

        return { from, to, updatedLinks };
    }

    // 创建空目录，支持自动创建中间目录
    async createCategory(path: string) {
        if (!path.startsWith('/')) {
            throw new InvalidPathError('路径必须为绝对路径');
        }

        const splitted = path.split('/').filter((p) => p.length > 0);
        if (splitted.length < 2) {
            throw new InvalidPathError(`无效的路径: ${path}`);
        }

        for (const item of splitted) {
            if (item.includes('.')) {
                throw new InvalidPathError('目录中不能含有`.`');
            }
        }

        const db = await getDB();
        await db.transaction(async (transaction) => {
            let currentCategoryId: number | undefined;
            for (let i = 0; i < splitted.length; i++) {
                const categoryName = splitted[i]!;
                let model: Category | null;

                if (currentCategoryId) {
                    model = await Category.findOne({ where: { parentId: currentCategoryId, name: categoryName } });
                } else {
                    model = await Category.findOne({ where: { novelId: this.id, name: categoryName } });
                    if (!model) {
                        throw new InvalidPathError(`不能在根目录${categoryName}下创建目录`);
                    }
                }

                const isLast = i === splitted.length - 1;
                if (!model) {
                    model = await Category.create(
                        { parentId: currentCategoryId!, name: categoryName },
                        { transaction },
                    );
                } else if (isLast) {
                    throw new ExistError(`目录\`${path}\`已存在`);
                }

                currentCategoryId = model.id;
            }
        });
    }

    // 以正则表达式替换的方式编辑文件
    async edit(path: string, regex: string, replace: string, flags?: string) {
        const text = (await this.read([path]))[0]?.text;
        if (!text) {
            throw new Error(`读取${path}时发生未知错误`);
        }

        const newText = text.replace(new RegExp(regex, flags), replace);
        if (newText == text) {
            throw new EditFailError('编辑后的字符串与原字符串相同');
        }

        await this.write(path, newText);
    }

    // 删除文件
    async deleteDocument(path: string) {
        if (!path.startsWith('/')) {
            throw new InvalidPathError('路径必须为绝对路径');
        }

        const splitted = path.split('/').filter((p) => p.length > 0);
        if (splitted.length < 2) {
            throw new InvalidPathError(`无效的路径: ${path}`);
        }

        const categoryPath = '/' + splitted.slice(0, -1).join('/');
        const name = splitted.at(-1)!;
        if (!name.endsWith('.md')) {
            throw new InvalidPathError('只能删除`.md`文件');
        }

        const { id: categoryId, rootId } = await this.findCategory(categoryPath);

        const db = await getDB();
        const documentId = await db.transaction(async (transaction) => {
            const document = await Document.findOne({ where: { categoryId, name }, transaction });
            if (!document) {
                throw new InvalidPathError(`文档\`${path}\`不存在`);
            }

            const documentId = document.id;

            // 链接维护：清理该文档自身的出链；把所有指向它的链接记录目标改写为 'deleted'。
            // （不重写引用文档的正文：正文里的链接下次编辑时按解析规则自然失效。）
            await DocumentLink.destroy({ where: { documentId }, transaction });
            await DocumentLink.update({ target: DELETED_LINK_TARGET }, { where: { target: path }, transaction });

            await document.destroy({ transaction });
            return documentId;
        });

        const chroma = await getChroma();
        const collection = await chroma.getCollection({ name: `category_${rootId}`, embeddingFunction });
        await collection.delete({ ids: [documentId.toString()] });
    }

    // 删除目录
    async deleteCategory(path: string) {
        if (!path.startsWith('/')) {
            throw new InvalidPathError('路径必须为绝对路径');
        }

        const { rootId, id } = await this.findCategory(path);
        if (rootId == id) {
            throw new InvalidPathError('不能删除根目录');
        }

        let documentIds: number[] = [];
        const findFiles = async (id: number) => {
            const categories = await Category.findAll({ where: { parentId: id } });
            for (const category of categories) {
                await findFiles(category.id);
            }
            const documents = await Document.findAll({ where: { categoryId: id } });
            for (const document of documents) {
                documentIds.push(document.id);
            }
        };
        await findFiles(id);

        // 收集将被删除的文档的绝对路径，用于把指向它们的链接记录目标改写为 'deleted'
        const documentPaths: string[] = [];
        for (const documentId of documentIds) {
            const model = await Document.findByPk(documentId);
            if (model) {
                documentPaths.push(`${await this.getCategoryPath(model.categoryId)}/${model.name}`);
            }
        }

        const db = await getDB();
        const chroma = await getChroma();
        const collection = await chroma.getCollection({ name: `category_${rootId}`, embeddingFunction });

        await db.transaction(async (transaction) => {
            // 链接维护：清理被删文档自身的出链；指向它们的入链目标改写为 'deleted'（语义与 deleteDocument 一致）
            if (documentIds.length > 0) {
                await DocumentLink.destroy({ where: { documentId: { [Op.in]: documentIds } }, transaction });
            }
            if (documentPaths.length > 0) {
                await DocumentLink.update(
                    { target: DELETED_LINK_TARGET },
                    { where: { target: { [Op.in]: documentPaths } }, transaction },
                );
            }

            await Document.destroy({ where: { id: { [Op.in]: documentIds } }, transaction });
            await Category.destroy({ where: { id }, transaction });
        });

        if (documentIds.length > 0) {
            await collection.delete({ ids: documentIds.map((i) => i.toString()) });
        }
    }
}
