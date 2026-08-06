// 会话与 CSRF cookie 边界。
import type { CookieConfig } from "@motro/config";

export const SESSION_COOKIE = "motro_session";
export const CSRF_COOKIE = "motro_csrf";

export function sessionCookieOptions(config: CookieConfig, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function csrfCookieOptions(config: CookieConfig) {
  return {
    httpOnly: false, // 客户端需读取以发送 x-csrf-token 头。
    secure: config.secure,
    sameSite: config.sameSite,
    path: "/",
  };
}
