import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "./http-errors.js";

/** 会话令牌请求头：由桌面主进程在 session 层注入窗口发出的每个请求。 */
export const SESSION_TOKEN_HEADER = "x-mycompanion-token";

/** 每次启动生成一个随机令牌；只存在于内存，不落盘。 */
export function createSessionToken(): string {
  return randomBytes(24).toString("base64url");
}

/** 恒定时间比较：先各自哈希，避免长度差异带来的时序信号。 */
export function sessionTokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !presented) return false;
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Fastify onRequest 守卫：令牌不匹配一律 401。
 *
 * 服务只监听 127.0.0.1，威胁模型是本机**其他进程与浏览器网页**——跨站 simple request
 * 不带自定义头也能把 POST 送达服务端（CSRF 面真实存在）；自定义头同时让浏览器跨源
 * 请求死于预检。令牌由桌面主进程经 session.webRequest 注入应用窗口的全部请求
 * （导航、fetch、流式、<img> 与前端卡 iframe），渲染层与卡脚本无需感知——
 * 按产品决策（spec §5.10）卡脚本是可信的高权限代码，守卫防的是应用之外。
 */
export function requireSessionToken(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!sessionTokenMatches(request.headers[SESSION_TOKEN_HEADER], expected)) {
      await sendError(reply, 401, "UNAUTHORIZED", "缺少或无效的会话令牌。");
    }
  };
}
