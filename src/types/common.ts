export interface PagedResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export function paged<T>(items: T[], total: number, page: number, pageSize: number): PagedResult<T> {
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}
