export class NotExistError extends Error {
    constructor(message?: string, options?: ErrorOptions) {
        super(message, options);
    }
}

export class ExistError extends Error {
    constructor(message?: string, options?: ErrorOptions) {
        super(message, options);
    }
}

export class InvalidPathError extends Error {
    constructor(message?: string, options?: ErrorOptions) {
        super(message, options);
    }
}

export class OutOfBoundsError extends Error {
    constructor(message?: string, options?: ErrorOptions) {
        super(message, options);
    }
}

export class EditFailError extends Error {
    constructor(message?: string, options?: ErrorOptions) {
        super(message, options);
    }
}
