import { Op } from '@sequelize/core';
import { ROOT_CATEGORY_NAMES, type RootCategoryName } from '@novel-writer/shared';
import { getChroma } from './db/chroma.js';
import { embeddingFunction } from './db/embedding.js';
import { Category } from './db/models/category.js';
import { Document } from './db/models/document.js';
import { Novel as NovelModel } from './db/models/novel.js';
import { getDB } from './db/sequelize.js';
import { EditFailError, ExistError, InvalidPathError, NotExistError, OutOfBoundsError } from './errors.js';

// 从 @novel-writer/shared 再导出，便于现有 `import { RootCategoryName } from '../lib/novel.js'` 调用方继续工作。
export type { RootCategoryName } from '@novel-writer/shared';
export { ROOT_CATEGORY_NAMES };

type SearchResult = {
    icon: string;
    name: string;
    children: SearchResult[];
};

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
    // 返回一个多行的字符串，每一行以缩进表示目录层级，以开头的emoji表示目录项类型
    // 🗂️表示非空目录，📁表示空目录，📂表示内容未知的目录，📄表示文件
    async list(path: string, recursive: boolean) {
        const { id: startId } = await this.findCategory(path);
        const searchDepth = recursive ? 5 : 1;

        const search = async (id: number, depth: number) => {
            const continueSearch = depth > 1;
            const results: SearchResult[] = [];

            const categories = await Category.findAll({ where: { parentId: id } });
            for (const category of categories) {
                const name = category.name;
                let icon: string;
                let children: SearchResult[] = [];
                if (continueSearch) {
                    children = await search(category.id, depth - 1);
                    if (children.length > 0) {
                        icon = '🗂️';
                    } else {
                        icon = '📁';
                    }
                } else {
                    icon = '📂';
                }
                results.push({ icon, name, children });
            }

            const documents = await Document.findAll({ where: { categoryId: id } });
            for (const document of documents) {
                results.push({ icon: '📄', name: document.name, children: [] });
            }

            return results;
        };
        const searchResult = await search(startId, searchDepth);

        const result = { value: '' };
        const parse = (result: SearchResult, indents: number, output: { value: string }) => {
            output.value += ' '.repeat(indents);
            output.value += `${result.icon} ${result.name}`;
            output.value += '\n';
            for (const child of result.children) {
                parse(child, indents + 2, output);
            }
        };
        for (const item of searchResult) {
            parse(item, 0, result);
        }

        return result.value;
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
            if (!text) {
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
    async write(path: string, text: string) {
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
            return { documentId: model.id, rootCategoryId: rootCategoryId! };
        });

        const chroma = await getChroma();
        const collection = await chroma.getCollection({ name: `category_${rootCategoryId}`, embeddingFunction });
        await collection.upsert({ ids: [documentId.toString()], documents: [text] });
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
            const document = await Document.findOne({ where: { categoryId, name } });
            if (!document) {
                throw new InvalidPathError(`文档\`${path}\`不存在`);
            }

            const documentId = document.id;
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

        const db = await getDB();
        const chroma = await getChroma();
        const collection = await chroma.getCollection({ name: `category_${rootId}`, embeddingFunction });

        await db.transaction(async (transaction) => {
            await Document.destroy({ where: { id: { [Op.in]: documentIds } }, transaction });
            await Category.destroy({ where: { id }, transaction });
        });

        if (documentIds.length > 0) {
            await collection.delete({ ids: documentIds.map((i) => i.toString()) });
        }
    }
}
