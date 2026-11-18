export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** 422 — the caller sent something that cannot be accepted. */
export class ValidationError extends AppError {
  constructor(message: string, field?: string) {
    super(422, 'validation', message, field);
  }
}

/** 409 — the request is well-formed but the state refuses it. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'conflict', message);
  }
}

/** 404 — the record does not exist (or is soft-deleted). */
export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, 'not_found', `${what} not found`);
  }
}

/** 403 — authenticated (or identifiable) but not allowed to continue. */
export class ForbiddenError extends AppError {
  constructor(message: string, code = 'forbidden') {
    super(403, code, message);
  }
}

/** 429 — too many attempts in the window. */
export class RateLimitError extends AppError {
  constructor(message: string) {
    super(429, 'rate_limited', message);
  }
}
