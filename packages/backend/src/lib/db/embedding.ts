import { OpenAIEmbeddingFunction } from '@chroma-core/openai';

export const embeddingFunction = new OpenAIEmbeddingFunction({
    apiBase: 'http://embedding:8000/v1',
    apiKey: '--',
    modelName: '/models/Qwen3-Embedding-0.6B-f16.gguf',
});
