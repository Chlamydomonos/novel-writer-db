import {
    CreationOptional,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    Model,
    NonAttribute,
} from '@sequelize/core';
import { Attribute, AutoIncrement, BelongsTo, HasMany, NotNull, PrimaryKey } from '@sequelize/core/decorators-legacy';
import { Novel } from './novel.js';
import { Document } from './document.js';

export class Category extends Model<InferAttributes<Category>, InferCreationAttributes<Category>> {
    @Attribute(DataTypes.INTEGER)
    @PrimaryKey
    @AutoIncrement
    declare id: CreationOptional<number>;

    @Attribute(DataTypes.STRING)
    @NotNull
    declare name: string;

    @Attribute(DataTypes.INTEGER)
    declare novelId?: number; // 只有顶层Category拥有此属性

    @Attribute(DataTypes.INTEGER)
    declare parentId?: number; // 只有非顶层Category拥有此属性

    @BelongsTo(() => Novel, {
        foreignKey: {
            name: 'novelId',
            onDelete: 'CASCADE',
        },
        targetKey: 'id',
        inverse: {
            type: 'hasMany',
            as: 'categories',
        },
        foreignKeyConstraints: true,
    })
    declare novel?: NonAttribute<Novel>;

    @HasMany(() => Category, {
        foreignKey: {
            name: 'parentId',
            onDelete: 'CASCADE',
        },
        sourceKey: 'id',
        inverse: {
            as: 'parent',
        },
        foreignKeyConstraints: true,
    })
    declare children?: NonAttribute<Category[]>;

    @BelongsTo(() => Category, {
        foreignKey: {
            name: 'parentId',
            onDelete: 'CASCADE',
        },
        targetKey: 'id',
        inverse: {
            type: 'hasMany',
            as: 'children',
        },
        foreignKeyConstraints: true,
    })
    declare parent?: NonAttribute<Category>;

    @HasMany(() => Document, {
        foreignKey: {
            name: 'categoryId',
            onDelete: 'CASCADE',
        },
        sourceKey: 'id',
        inverse: {
            as: 'category',
        },
        foreignKeyConstraints: true,
    })
    declare documents?: NonAttribute<Document[]>;
}
