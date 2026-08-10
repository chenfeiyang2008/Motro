// 导入模块 DI token。独立成文件以避免 import.module ↔ import.service 的循环依赖。
export const APP_CONFIG = Symbol("APP_CONFIG");
