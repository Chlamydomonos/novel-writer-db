import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody, KnownErrorType } from '@novel-writer/shared';

export class ApiError extends Error {
    constructor(
        public status: number,
        public type: KnownErrorType,
        message: string,
    ) {
        super(message);
    }
}

const http: AxiosInstance = axios.create({
    baseURL: '/api',
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => config);

http.interceptors.response.use(
    (response) => (response.status === 204 ? undefined : response.data),
    async (error: AxiosError) => {
        const status = error.response?.status ?? 0;

        // 二进制响应（`responseType: 'blob'`，如导出归档）出错时，错误体同样是 Blob，
        // 需先读成文本再按统一错误结构解析。
        let payload: unknown = error.response?.data;
        if (payload instanceof Blob) {
            try {
                payload = JSON.parse(await payload.text());
            } catch {
                payload = undefined;
            }
        }

        const detail = (payload as ApiErrorBody | undefined)?.error;
        const type = (detail?.type ?? 'Unknown') as KnownErrorType;
        const message = detail?.message ?? error.message;
        return Promise.reject(new ApiError(status, type, message));
    },
);

export { http };
