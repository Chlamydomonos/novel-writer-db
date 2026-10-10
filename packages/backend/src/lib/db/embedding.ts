import { OpenAIEmbeddingFunction } from '@chroma-core/openai';

// 嵌入服务的 OpenAI 兼容地址与模型，均可在部署时通过环境变量覆盖：
//   EMBEDDING_API_BASE — OpenAI 兼容 base URL（默认 compose 内 llama.cpp 容器服务名 `embedding`）
//   EMBEDDING_API_KEY  — API key；llama.cpp 不校验，传占位符即可；真实云厂商须提供有效 key
//   EMBEDDING_MODEL    — 模型名；llama.cpp 忽略请求中的 model 字段，云厂商须填真实模型名
// 用法见仓库根目录 `docker-compose.yml`（内置 embedding 容器）与
// `docker-compose.external-embedding.yml`（不启动 embedding，改用远程嵌入服务）。
export const embeddingFunction = new OpenAIEmbeddingFunction({
    apiBase: process.env.EMBEDDING_API_BASE ?? 'http://embedding:8000/v1',
    apiKey: process.env.EMBEDDING_API_KEY ?? '--',
    modelName: process.env.EMBEDDING_MODEL ?? '/models/Qwen3-Embedding-0.6B-f16.gguf',
});
