import { ChromaClient } from 'chromadb';

let client: ChromaClient | undefined = undefined;

export const getRootCategoryCollectionName = (rootCategoryId: number) => rootCategoryId.toString().padStart(3, '0');

const createChromaClient = async () => {
    const client = new ChromaClient({
        host: 'chroma',
        port: 8000,
    });

    await client.heartbeat();

    return client;
};

export const getChroma = async () => {
    if (!client) {
        client = await createChromaClient();
    }

    return client;
};
