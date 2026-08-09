export function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function createErrorResponse(message, status = 502) {
  return {
    ok: false,
    status,
    async json() {
      return {
        ok: false,
        data: null,
        error: { message }
      };
    }
  };
}

export function createGatewayResponse() {
  return {
    body: null,
    statusCode: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    }
  };
}

export function createSuccessResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, data, error: null };
    }
  };
}
