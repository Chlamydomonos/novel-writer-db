/**
 * 对照实验自动化脚本
 *
 * 用途：
 *   1. 读取 experiment/data.json 导入实验数据
 *   2. 读取 experiment/queries.json 执行对照检索实验
 *   3. 对比三根目录 vs 混合存储的检索效果
 *
 * 前置条件：后端服务已在 http://127.0.0.1:3912 运行（nginx 反代）
 *
 * 用法：
 *   node experiment/run-experiment.mjs                    # 完整流程（导入+运行+对比）
 *   node experiment/run-experiment.mjs --skip-import      # 仅运行实验（跳过导入）
 *   node experiment/run-experiment.mjs --cleanup          # 运行后自动删除实验
 *   node experiment/run-experiment.mjs --experiment-id 3  # 对已有实验运行
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://127.0.0.1:3912';
const DATA_PATH = resolve(__dirname, 'data.json');
const QUERIES_PATH = resolve(__dirname, 'queries.json');

// ===========================================================================
// 命令行参数解析
// ===========================================================================

const args = process.argv.slice(2);
const FLAGS = {
    skipImport: args.includes('--skip-import'),
    cleanup: args.includes('--cleanup'),
};

const experimentIdArg = args.findIndex((a) => a === '--experiment-id');
const EXPERIMENT_ID_OVERRIDE = experimentIdArg !== -1 ? Number(args[experimentIdArg + 1]) : undefined;

// ===========================================================================
// 工具函数
// ===========================================================================

async function request(method, path, body) {
    const url = `${BASE_URL}${path}`;
    const opts = {
        method,
        headers: {},
    };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }

    let res;
    try {
        res = await fetch(url, opts);
    } catch (err) {
        throw new Error(
            `无法连接到 ${url}\n` + `  原因: ${err.message}\n` + `  请确保后端服务已启动 (docker compose up -d)`,
        );
    }

    const text = await res.text();

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        // 响应不是 JSON（HTML 错误页等），输出原始内容
        const preview = text.slice(0, 800);
        throw new Error(
            `请求失败 [HTTP ${res.status}] ${method} ${path}\n` +
                `  响应非 JSON，原始内容:\n` +
                `  ${'─'.repeat(60)}\n${preview}${text.length > 800 ? '\n  ...(截断)' : ''}\n  ${'─'.repeat(60)}`,
        );
    }

    if (!res.ok) {
        throw new Error(`[${res.status}] ${method} ${path}: ${JSON.stringify(data)}`);
    }
    return data;
}

/** 格式化毫秒显示 */
function formatMs(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/** 比例转百分比字符串 */
function pct(val) {
    return `${(val * 100).toFixed(1)}%`;
}

/** 打印分隔线 */
function hr(title) {
    const line = '═'.repeat(68);
    console.log(`\n${line}`);
    if (title) console.log(`  ${title}`);
    console.log(line);
}

/** 从路径提取文档名 */
function docName(path) {
    return path.split('/').pop() || path;
}

// ===========================================================================
// 预处理：为含 content 的节点名添加 .md 后缀
// ===========================================================================

/**
 * 递归遍历树，为有 content 的节点添加 .md 后缀。
 * 这是因为 importTree 用 .md 后缀判断文档节点。
 */
function addMdSuffix(nodes) {
    for (const node of nodes) {
        if (node.content !== undefined && !node.name.endsWith('.md')) {
            node.name += '.md';
        }
        if (node.children) {
            addMdSuffix(node.children);
        }
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║     对照实验：三根目录检索 vs 混合存储检索                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    // ------------------------------------------------------------------
    // Step 1：确定实验 ID
    // ------------------------------------------------------------------
    let experimentId = EXPERIMENT_ID_OVERRIDE;

    if (!experimentId && !FLAGS.skipImport) {
        hr('STEP 1：导入实验数据');

        console.log(`读取数据文件: ${DATA_PATH}`);
        const rawData = readFileSync(DATA_PATH, 'utf-8');
        const data = JSON.parse(rawData);

        // 为 content-bearing 节点添加 .md 后缀（importTree 要求）
        console.log('预处理: 为文档节点添加 .md 后缀');
        if (data.settings) addMdSuffix(data.settings);
        if (data.outlines) addMdSuffix(data.outlines);
        if (data.chapters) addMdSuffix(data.chapters);

        const experimentName = `exp-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        console.log(`导入实验: "${experimentName}"`);
        console.log(
            `数据规模: ${data.settings?.length ?? 0} 设定节点, ${data.outlines?.length ?? 0} 大纲节点, ${data.chapters?.length ?? 0} 正文节点`,
        );

        const importRes = await request('POST', `/api/experiments/import?name=${encodeURIComponent(experimentName)}`, {
            settings: data.settings,
            outlines: data.outlines,
            chapters: data.chapters,
        });

        experimentId = importRes.experimentId;
        console.log(`✓ 导入成功！experimentId=${experimentId}, novelId=${importRes.novelId}`);
        console.log(
            `  文档统计: 设定=${importRes.stats.settingDocs}, 大纲=${importRes.stats.outlineDocs}, 正文=${importRes.stats.chapterDocs}, 合计=${importRes.stats.totalDocs}`,
        );
    } else if (!experimentId && FLAGS.skipImport) {
        // 列出已有实验
        console.log('跳过导入，获取已有实验列表...');
        const experiments = await request('GET', '/api/experiments');
        if (experiments.length === 0) {
            throw new Error('没有找到任何实验。请先运行不带 --skip-import 的完整导入。');
        }
        experimentId = experiments[0].id;
        console.log(`使用最近的实验: id=${experimentId}, name="${experiments[0].name}"`);
    }

    // ------------------------------------------------------------------
    // Step 2：加载查询并执行
    // ------------------------------------------------------------------
    hr('STEP 2：执行对照检索实验');

    console.log(`加载查询文件: ${QUERIES_PATH}`);
    const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf-8'));

    console.log(`实验参数: experimentId=${experimentId}, k=5, 查询数=${queries.length}`);

    const result = await request('POST', `/api/experiments/${experimentId}/run`, { k: 5, queries });

    // ------------------------------------------------------------------
    // Step 3：输出详细结果
    // ------------------------------------------------------------------
    hr('STEP 3：逐查询对比');

    // 表头
    const header =
        '│ 查询                                │ 目标  │ 三根 Recall │ 三根 MRR │ 三根延迟  │ 混合 Recall │ 混合 MRR │ 混合延迟  │ 混合污染 │';
    const separator =
        '│─────────────────────────────────────│───────│────────────│──────────│──────────│────────────│──────────│──────────│─────────│';

    console.log(`┌${'─'.repeat(130)}┐`);
    console.log(header);
    console.log(separator);

    for (const pq of result.perQuery) {
        const q = pq.query.length > 33 ? pq.query.slice(0, 31) + '…' : pq.query.padEnd(33);
        const tgt = pq.targetRoot.padEnd(5);
        const rec3 = pct(pq.threeRoot.recall).padEnd(10);
        const mrr3 = pq.threeRoot.reciprocalRank.toFixed(3).padEnd(8);
        const lat3 = formatMs(pq.threeRoot.latencyMs).padEnd(8);
        const recM = pct(pq.mixed.recall).padEnd(10);
        const mrrM = pq.mixed.reciprocalRank.toFixed(3).padEnd(8);
        const latM = formatMs(pq.mixed.latencyMs).padEnd(8);
        const cont = String(pq.mixed.contaminated).padEnd(7);

        console.log(`│ ${q} │ ${tgt} │ ${rec3} │ ${mrr3} │ ${lat3} │ ${recM} │ ${mrrM} │ ${latM} │ ${cont} │`);
    }

    console.log(`└${'─'.repeat(130)}┘`);

    // ------------------------------------------------------------------
    // Step 4：聚合结果对比
    // ------------------------------------------------------------------
    hr('STEP 4：聚合指标对比');

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    聚合性能对比                              ║');
    console.log('╠══════════════════════════════╤══════════════╤══════════════╣');
    console.log('║           指标                │  三根目录    │  混合存储    ║');
    console.log('╠══════════════════════════════╪══════════════╪══════════════╣');
    console.log(
        `║ 平均延迟                     │ ${formatMs(result.threeRoot.avgLatencyMs).padEnd(12)} │ ${formatMs(result.mixed.avgLatencyMs).padEnd(12)} ║`,
    );
    console.log('╠══════════════════════════════╪══════════════╪══════════════╣');
    console.log(
        `║ Recall@${result.k}                     │ ${pct(result.threeRoot.recallAtK).padEnd(12)} │ ${pct(result.mixed.recallAtK).padEnd(12)} ║`,
    );
    console.log('╠══════════════════════════════╪══════════════╪══════════════╣');
    console.log(
        `║ MRR                          │ ${result.threeRoot.mrr.toFixed(4).padEnd(12)} │ ${result.mixed.mrr.toFixed(4).padEnd(12)} ║`,
    );
    console.log('╠══════════════════════════════╧══════════════╪══════════════╣');
    console.log(`║ 混合存储污染率               │              │ ${pct(result.mixed.contaminationRate).padEnd(12)} ║`);
    console.log('╚═════════════════════════════════════════════╧══════════════╝');

    // ------------------------------------------------------------------
    // Step 5：分析总结
    // ------------------------------------------------------------------
    hr('STEP 5：分析总结');

    const diffRecall = result.threeRoot.recallAtK - result.mixed.recallAtK;
    const diffMmr = result.threeRoot.mrr - result.mixed.mrr;
    const diffLat = result.mixed.avgLatencyMs - result.threeRoot.avgLatencyMs;

    console.log(
        `  Recall@${result.k} 差异: ${diffRecall >= 0 ? '三根更优' : '混合更优'} (Δ = ${(Math.abs(diffRecall) * 100).toFixed(1)} 百分点)`,
    );
    console.log(
        `  MRR 差异:              ${diffMmr >= 0 ? '三根更优' : '混合更优'} (Δ = ${Math.abs(diffMmr).toFixed(4)})`,
    );
    console.log(
        `  延迟差异:              ${diffLat >= 0 ? '混合更慢' : '混合更快'} (Δ = ${formatMs(Math.abs(diffLat))})`,
    );
    console.log(
        `  混合存储污染率:        ${pct(result.mixed.contaminationRate)} (检索到的 ${result.k * result.perQuery.length} 个结果中 ${result.perQuery.reduce((s, q) => s + q.mixed.contaminated, 0)} 个来自错误根目录)`,
    );

    // 按根目录分组的"污染"分析
    console.log(`\n  按目标根目录分组的混合污染: `);
    const byRoot = {};
    for (const pq of result.perQuery) {
        if (!byRoot[pq.targetRoot]) {
            byRoot[pq.targetRoot] = { total: 0, contaminated: 0 };
        }
        byRoot[pq.targetRoot].total += result.k;
        byRoot[pq.targetRoot].contaminated += pq.mixed.contaminated;
    }
    for (const [root, stats] of Object.entries(byRoot)) {
        console.log(
            `    ${root}: ${stats.contaminated}/${stats.total} 条污染 (${pct(stats.contaminated / stats.total)})`,
        );
    }

    // 找出最佳和最差查询
    console.log(`\n  检索效果最佳查询 (最高三根Recall):`);
    const best = result.perQuery.reduce((a, b) =>
        a.threeRoot.recall + a.threeRoot.reciprocalRank > b.threeRoot.recall + b.threeRoot.reciprocalRank ? a : b,
    );
    console.log(`    "${best.query}" → 三根Recall=${pct(best.threeRoot.recall)}, 混合Recall=${pct(best.mixed.recall)}`);

    console.log(`\n  检索效果最差查询 (最低三根Recall):`);
    const worst = result.perQuery.reduce((a, b) =>
        a.threeRoot.recall + a.threeRoot.reciprocalRank < b.threeRoot.recall + b.threeRoot.reciprocalRank ? a : b,
    );
    console.log(
        `    "${worst.query}" → 三根Recall=${pct(worst.threeRoot.recall)}, 混合Recall=${pct(worst.mixed.recall)}`,
    );

    // ------------------------------------------------------------------
    // Step 6：可选清理
    // ------------------------------------------------------------------
    if (FLAGS.cleanup) {
        hr('STEP 6：清理实验数据');
        await request('DELETE', `/api/experiments/${experimentId}`);
        console.log(`✓ 实验 id=${experimentId} 已删除`);
    } else {
        console.log(
            `\n实验 id=${experimentId} 已保留。使用 --cleanup 自动删除, 或手动: curl -X DELETE ${BASE_URL}/api/experiments/${experimentId}`,
        );
    }

    console.log('');
}

main().catch((err) => {
    console.error('✗ 实验失败:', err.message);
    if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch')) {
        console.error('  请确保后端服务已启动: cd packages/backend && pnpm dev');
    }
    process.exit(1);
});
