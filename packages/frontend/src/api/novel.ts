import { http } from './client';
import type {
    CreateNovelRequest,
    EditDocumentRequest,
    ListQuery,
    ListResponse,
    ListTextResponse,
    NovelDetail,
    NovelSummary,
    PatchNovelRequest,
    ReadResponse,
    SearchRequest,
    SearchResponse,
    WriteDocumentRequest,
} from '@novel-writer/shared';

export const listNovels = () => http.get<unknown, NovelSummary[]>('/novels');

export const createNovel = (payload: CreateNovelRequest) => http.post<unknown, NovelDetail>('/novels', payload);

export const getNovel = (novelId: number) => http.get<unknown, NovelDetail>(`/novels/${novelId}`);

export const patchNovel = (novelId: number, payload: PatchNovelRequest) =>
    http.patch<unknown, NovelDetail>(`/novels/${novelId}`, payload);

export const deleteNovel = (novelId: number) => http.delete<unknown, void>(`/novels/${novelId}`);

export const listByPath = (novelId: number, query: ListQuery) =>
    http.get<unknown, ListTextResponse>(`/novels/${novelId}/list`, {
        params: {
            path: query.path,
            recursive: query.recursive,
        },
    });

export const listTree = (novelId: number, path: string) =>
    http.get<unknown, ListResponse>(`/novels/${novelId}/tree`, {
        params: { path },
    });

export const readDocuments = (novelId: number, paths: string[]) =>
    http.post<unknown, ReadResponse>(`/novels/${novelId}/read`, { paths });

export const writeDocument = (novelId: number, payload: WriteDocumentRequest) =>
    http.post<unknown, void>(`/novels/${novelId}/write`, payload);

export const editDocument = (novelId: number, payload: EditDocumentRequest) =>
    http.post<unknown, void>(`/novels/${novelId}/edit`, payload);

export const searchDocuments = (novelId: number, payload: SearchRequest) =>
    http.post<unknown, SearchResponse>(`/novels/${novelId}/search`, payload);

export const deleteDocument = (novelId: number, path: string) =>
    http.delete<unknown, void>(`/novels/${novelId}/documents`, {
        params: { path },
    });

export const deleteCategory = (novelId: number, path: string) =>
    http.delete<unknown, void>(`/novels/${novelId}/categories`, {
        params: { path },
    });
