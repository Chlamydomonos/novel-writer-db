import {
    CreationOptional,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    Model,
    NonAttribute,
} from '@sequelize/core';
import { Attribute, AutoIncrement, BelongsTo, NotNull, PrimaryKey } from '@sequelize/core/decorators-legacy';
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
}
