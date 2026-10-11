import {
    CreationOptional,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    Model,
    NonAttribute,
} from '@sequelize/core';
import { Attribute, AutoIncrement, BelongsTo, HasMany, NotNull, PrimaryKey } from '@sequelize/core/decorators-legacy';
import { DocumentLink } from './document-link.js';
import { Category } from './category.js';

export class Document extends Model<InferAttributes<Document>, InferCreationAttributes<Document>> {
    @Attribute(DataTypes.INTEGER)
    @PrimaryKey
    @AutoIncrement
    declare id: CreationOptional<number>;

    @Attribute(DataTypes.STRING)
    @NotNull
    declare name: string;

    @Attribute(DataTypes.INTEGER)
    @NotNull
    declare categoryId: number;

    @BelongsTo(() => Category, {
        foreignKey: {
            name: 'categoryId',
            onDelete: 'CASCADE',
        },
        targetKey: 'id',
        inverse: {
            type: 'hasMany',
            as: 'documents',
        },
        foreignKeyConstraints: true,
    })
    declare category: NonAttribute<Category>;

    @HasMany(() => DocumentLink, {
        foreignKey: {
            name: 'documentId',
            onDelete: 'CASCADE',
        },
        sourceKey: 'id',
        inverse: {
            as: 'document',
        },
        foreignKeyConstraints: true,
    })
    declare links?: NonAttribute<DocumentLink[]>;
}
