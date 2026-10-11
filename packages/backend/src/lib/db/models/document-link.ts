import {
    CreationOptional,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    Model,
    NonAttribute,
} from '@sequelize/core';
import { Attribute, AutoIncrement, BelongsTo, NotNull, PrimaryKey } from '@sequelize/core/decorators-legacy';
import { Document } from './document.js';

/**
 * 文档间 Markdown 链接（有向边：source → target）。
 *
 * 由后端在**写入/编辑文档时自动解析**维护，不对任何 API 直接暴露写入接口：
 * - `target` 存目标文档的**绝对路径**（如 `/设定/人物卡.md`）；
 *   解析规则见 `lib/links.ts`：仅当链接指向 `.md` 文件且该文件真实存在时才入库，其余链接一律忽略；
 * - `target` 也可以是字面量 `'deleted'`：文档被删除时，所有指向它的链接记录的目标会被改写为该值，
 *   表示"这个链接曾经指向一个已删除的文档"（普通绝对路径以 `/` 开头，可与该字面量无歧义区分）。
 *
 * 同一文档内出现的重复目标会去重存储（一条 `(documentId, target)` 唯一记录）。
 * 文档删除后其**出链**（本表 `documentId` 指向该文档的行）随之删除。
 */
export class DocumentLink extends Model<InferAttributes<DocumentLink>, InferCreationAttributes<DocumentLink>> {
    @Attribute(DataTypes.INTEGER)
    @PrimaryKey
    @AutoIncrement
    declare id: CreationOptional<number>;

    /** 链接所在的源文档（出链的持有者）。 */
    @Attribute(DataTypes.INTEGER)
    @NotNull
    declare documentId: number;

    /** 目标文档绝对路径；文档被删除后改写为字面量 `'deleted'`。 */
    @Attribute(DataTypes.STRING)
    @NotNull
    declare target: string;

    @BelongsTo(() => Document, {
        foreignKey: {
            name: 'documentId',
            onDelete: 'CASCADE',
        },
        targetKey: 'id',
        inverse: {
            type: 'hasMany',
            as: 'links',
        },
        foreignKeyConstraints: true,
    })
    declare document: NonAttribute<Document>;
}
