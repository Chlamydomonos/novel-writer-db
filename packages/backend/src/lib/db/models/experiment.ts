import {
    CreationOptional,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    Model,
    NonAttribute,
} from '@sequelize/core';
import { Attribute, AutoIncrement, BelongsTo, CreatedAt, NotNull, PrimaryKey } from '@sequelize/core/decorators-legacy';
import { Novel } from './novel.js';

export class Experiment extends Model<InferAttributes<Experiment>, InferCreationAttributes<Experiment>> {
    @Attribute(DataTypes.INTEGER)
    @PrimaryKey
    @AutoIncrement
    declare id: CreationOptional<number>;

    @Attribute(DataTypes.INTEGER)
    @NotNull
    declare novelId: number;

    @Attribute(DataTypes.STRING)
    @NotNull
    declare name: string;

    @Attribute(DataTypes.STRING)
    @NotNull
    declare mixedCollectionName: string;

    @CreatedAt
    declare createdAt: CreationOptional<Date>;

    @BelongsTo(() => Novel, {
        foreignKey: {
            name: 'novelId',
            onDelete: 'CASCADE',
        },
        targetKey: 'id',
        inverse: {
            type: 'hasMany',
            as: 'experiments',
        },
        foreignKeyConstraints: true,
    })
    declare novel?: NonAttribute<Novel>;
}
