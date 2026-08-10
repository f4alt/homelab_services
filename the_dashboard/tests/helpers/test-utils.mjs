export function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

export async function withPatchedGlobals(overrides, run) {
  const descriptors = new Map(
    Object.keys(overrides).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name)
    ])
  );

  for (const [name, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true
    });
  }

  try {
    return await run();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
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
