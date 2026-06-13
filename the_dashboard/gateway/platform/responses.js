export function sendOk(res, data, status = 200) {
  return res.status(status).json({
    ok: true,
    data,
    error: null
  });
}

export function sendError(res, status, code, message, details = null) {
  return res.status(status).json({
    ok: false,
    data: null,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  });
}

export function errorPayload(code, message, details = null) {
  return {
    code,
    message,
    ...(details ? { details } : {})
  };
}
