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
    (error: AxiosError<ApiErrorBody>) => {
        const status = error.response?.status ?? 0;
        const type = (error.response?.data?.error?.type ?? 'Unknown') as KnownErrorType;
        const message = error.response?.data?.error?.message ?? error.message;
        return Promise.reject(new ApiError(status, type, message));
    },
);

export { http };
