import {
    CreationOptional,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    Model,
    NonAttribute,
} from '@sequelize/core';
import { Attribute, AutoIncrement, Default, HasMany, NotNull, PrimaryKey } from '@sequelize/core/decorators-legacy';
import { Category } from './category.js';

export class Novel extends Model<InferAttributes<Novel>, InferCreationAttributes<Novel>> {
    @Attribute(DataTypes.INTEGER)
    @PrimaryKey
    @AutoIncrement
    declare id: CreationOptional<number>;

    @Attribute(DataTypes.STRING)
    @NotNull
    declare name: string;

    @Attribute(DataTypes.STRING)
    @NotNull
    @Default('')
    declare info: CreationOptional<string>;

    @HasMany(() => Category, {
        foreignKey: {
            name: 'novelId',
            onDelete: 'CASCADE',
        },
        sourceKey: 'id',
        inverse: {
            as: 'novel',
        },
        foreignKeyConstraints: true,
    })
    declare categories?: NonAttribute<Category[]>;
}
