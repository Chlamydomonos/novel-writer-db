import Sequelize from '@sequelize/core';
import { SqliteDialect } from '@sequelize/sqlite3';
import { Category } from './models/category.js';
import { Document } from './models/document.js';
import { Novel } from './models/novel.js';

let db: Sequelize<SqliteDialect> | undefined = undefined;

const createSequelize = async () => {
    const db = new Sequelize({
        dialect: SqliteDialect,
        storage: '/data/db.sqlite3',
        define: {
            timestamps: false,
        },
        models: [Category, Document, Novel],
        pool: {
            max: 1,
            min: 1,
        },
        retry: {
            max: 5,
            match: [/SQLITE_BUSY/i],
        },
    });

    await db.sync();
    await db.query('PRAGMA journal_mode = WAL');
    await db.query('PRAGMA synchronous = NORMAL');
    await db.query('PRAGMA busy_timeout = 5000');
    return db;
};

export const getDB = async () => {
    if (!db) {
        db = await createSequelize();
    }

    return db;
};
