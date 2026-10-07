/** 统一响应封装与业务异常 */

export class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const ok = (data = null, message = 'ok') => ({ code: 0, message, data });
export const fail = (message, code = 'ERROR', status = 400, extra = null) => ({
  code,
  message,
  data: extra,
  _status: status,
});

/** 把返回值包装成 Fastify 可用的响应 */
export function replyWith(reply, result) {
  if (result && typeof result === 'object' && '_status' in result) {
    const { _status, ...rest } = result;
    return reply.code(_status).send(rest);
  }
  return reply.send(result);
}

/** 路由包装：统一捕获异常 */
export function wrap(handler) {
  return async (request, reply) => {
    try {
      const r = await handler(request, reply);
      if (r === undefined) return reply;
      return replyWith(reply, r);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) request.log?.error?.(e);
      return reply.code(status).send({
        code: e.code || 'ERROR',
        message: e.message || '服务内部错误',
        data: e.extra ?? null,
      });
    }
  };
}

export const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};
